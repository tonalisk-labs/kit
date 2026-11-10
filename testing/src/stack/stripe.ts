import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { IDLE_CONNECTION_MS } from './edge.ts';
import type { Service } from './process.ts';
import { routeMatches } from './route-key.ts';
import { Script, STRIPE_JS } from './stripe-js.ts';
import {
  createPayment,
  dashboardRefund,
  expirePayment,
  id,
  isPayment,
  missing,
  payLater,
  type Payments,
  paymentForm,
  paymentsOf,
  payNow,
  readPayment,
  redeliver,
  type Reply,
  settle,
  signature,
  whenDelivered,
} from './stripe-payments.ts';
import {
  cancelNow,
  compose,
  composedCall,
  type Customer,
  type Fake,
  invoiceOf,
  type Ledger,
  type Plan,
  refundIntent,
  restart,
  subscribe,
  type Subscription,
  subscriptionsOf,
} from './stripe-subscriptions.ts';

export type { Plan } from './stripe-subscriptions.ts';

export interface FakeStripe extends Service {
  /** The API base a backend is pointed at, and the host of the fake Checkout and portal pages. */
  readonly url: string;
  readonly secretKey: string;
  /** The key a page initialises Stripe.js with. */
  readonly publishableKey: string;
  readonly webhookSecret: string;
  /** Each plan's price, by the plan's id: here the very same id. */
  readonly prices: ReadonlyMap<string, string>;
}

interface State {
  readonly url: string;
  readonly plans: ReadonlyMap<string, Plan>;
  readonly customers: Map<string, Customer>;
  readonly sessions: Map<string, URLSearchParams>;
  readonly subscriptions: Map<string, Subscription>;
  readonly deleted: EventTarget;
  readonly webhook: { readonly url: string; readonly secret: string };
  /** Late-webhook mode: events wait here until released. */
  held: string[] | undefined;
  /** One-time payments, Checkout's `mode=payment`. */
  readonly payments: Payments;
  /** The subscriptions, with what they share with the rest of the fake. */
  readonly fake: Fake;
}

const formOf = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks = await Array.fromAsync(request, (chunk: Buffer) => chunk.toString('utf8'));
  return new URLSearchParams(chunks.join(''));
};

/** An error with its causes, as `fetch` names the socket's or TLS's failure only there. */
const described = (error: unknown): string =>
  error instanceof Error && error.cause !== undefined
    ? `${String(error)}: ${described(error.cause)}`
    : String(error);

const deliver = async (state: State, payload: string): Promise<void> => {
  const response = await fetch(state.webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature(payload, state.webhook.secret),
    },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(`the webhook answered ${String(response.status)}: ${await response.text()}`);
  }
};

/** Announces a subscription change; in late-webhook mode the event is held instead. */
const announce = async (state: State, type: string, object: Subscription): Promise<void> => {
  const payload = JSON.stringify({ id: id('evt'), type, data: { object } });
  if (state.held === undefined) {
    await deliver(state, payload);
  } else {
    state.held.push(payload);
  }
};

const price = (state: State, priceId: string): Reply => {
  const plan = state.plans.get(priceId);
  if (plan === undefined) {
    return missing;
  }
  const options = Object.fromEntries(
    Object.entries(plan.amounts).map(([currency, amount]) => [currency, { unit_amount: amount }]),
  );
  return [200, { id: plan.id, recurring: { interval: plan.interval }, currency_options: options }];
};

/** Customers are keyed by their idempotency key, as Stripe replays a repeated create. */
const createCustomer = (state: State, form: URLSearchParams, key: string | undefined): Reply => {
  const existing = key === undefined ? undefined : state.customers.get(key);
  const customer = existing ?? { id: id('cus'), email: form.get('email') };
  state.customers.set(key ?? customer.id, customer);
  state.customers.set(customer.id, customer);
  return [200, customer];
};

const deleteCustomer = (state: State, customerId: string): Reply => {
  const customer = state.customers.get(customerId);
  if (customer === undefined) {
    return missing;
  }
  state.customers.delete(customerId);
  state.deleted.dispatchEvent(new Event(customerId));
  return [200, { id: customerId, deleted: true }];
};

const createSession = (state: State, form: URLSearchParams): Reply => {
  const session = id('cs');
  state.sessions.set(session, form);
  return [200, { id: session, url: `${state.url}/checkout/${session}` }];
};

/** Pays a checkout once, as Stripe completes it once: the session is taken before the subscription
 *  starts, so a second pay meanwhile finds it gone, and put back should the subscription fail. */
const pay = async (state: State, session: string): Promise<Reply> => {
  const form = state.sessions.get(session);
  if (form === undefined) {
    return missing;
  }
  state.sessions.delete(session);
  if (!(await subscribe(state.fake, form))) {
    state.sessions.set(session, form);
    return missing;
  }
  return [303, {}, form.get('success_url') ?? state.url];
};

const subscription = (state: State, subscriptionId: string): Reply => {
  const found = state.subscriptions.get(subscriptionId);
  return found === undefined ? missing : [200, found];
};

const updateSubscription = async (state: State, call: Call): Promise<Reply> => {
  const found = state.subscriptions.get(at(call, 2));
  if (found === undefined) {
    return missing;
  }
  found.cancel_at_period_end = call.form.get('cancel_at_period_end') === 'true';
  await announce(state, 'customer.subscription.updated', found);
  return [200, found];
};

const portal = (state: State, form: URLSearchParams): Reply => {
  const target = new URL(`${state.url}/portal/${id('bps')}`);
  target.searchParams.set('return', form.get('return_url') ?? state.url);
  return [200, { url: target.href }];
};

/** Delivers held events one at a time, in the order they were held. */
const deliverInOrder = async (state: State, payloads: readonly string[]): Promise<void> => {
  const [first, ...rest] = payloads;
  if (first !== undefined) {
    await deliver(state, first);
    await deliverInOrder(state, rest);
  }
};

const release = async (state: State): Promise<Reply> => {
  const held = state.held ?? [];
  state.held = undefined;
  await deliverInOrder(state, held);
  return [200, { released: held.length }];
};

/** A renewal payment fails: Stripe marks the subscription past due and says it changed. */
const pastDue = async (state: State, subscriptionId: string): Promise<Reply> => {
  const found = state.subscriptions.get(subscriptionId);
  if (found === undefined) {
    return missing;
  }
  found.status = 'past_due';
  await announce(state, 'customer.subscription.updated', found);
  return [200, found];
};

const hold = (state: State): Reply => {
  state.held ??= [];
  return [200, { holding: true }];
};

/** Resolves once the customer is deleted: an event, bounded by the caller's own timeout. */
const whenDeleted = async (state: State, customerId: string): Promise<Reply> => {
  if (state.customers.has(customerId)) {
    await once(state.deleted, customerId);
  }
  return [200, { id: customerId, deleted: true }];
};

interface Call {
  readonly segments: readonly string[];
  readonly form: URLSearchParams;
  readonly query: URLSearchParams;
  readonly idempotency: string | undefined;
}

type Handler = (state: State, call: Call) => Reply | Promise<Reply>;

const at = (call: Call, index: number): string => call.segments[index] ?? '';

/** Method and path, with `*` for one variable segment. */
const ROUTES: readonly (readonly [string, Handler])[] = [
  ['GET /v1/prices/*', (state, call) => price(state, at(call, 2))],
  ['POST /v1/customers', (state, call) => createCustomer(state, call.form, call.idempotency)],
  ['GET /v1/customers/*', (state, call) => [200, state.customers.get(at(call, 2)) ?? missing[1]]],
  ['DELETE /v1/customers/*', (state, call) => deleteCustomer(state, at(call, 2))],
  [
    'POST /v1/checkout/sessions',
    (state, call) => {
      if (call.form.get('mode') === 'payment') {
        return createPayment(state.payments, call.form, call.idempotency);
      }
      return call.form.get('ui_mode') === 'elements'
        ? compose(state.fake.books, call.form)
        : createSession(state, call.form);
    },
  ],
  [
    'GET /v1/checkout/sessions/*',
    (state, call) =>
      readPayment(state.payments, at(call, 3), call.query.getAll('expand[]').length > 0),
  ],
  [
    'POST /v1/checkout/sessions/*/expire',
    (state, call) => expirePayment(state.payments, at(call, 3)),
  ],
  ['POST /v1/refunds', (state, call) => refundIntent(state.fake, call.form, call.idempotency)],
  ['GET /v1/invoices/*', (state, call) => invoiceOf(state.fake.books, at(call, 2))],
  ['DELETE /v1/subscriptions/*', async (state, call) => cancelNow(state.fake.ledger, at(call, 2))],
  ['POST /v1/billing_portal/sessions', (state, call) => portal(state, call.form)],
  ['GET /v1/subscriptions/*', (state, call) => subscription(state, at(call, 2))],
  ['POST /v1/subscriptions/*', async (state, call) => updateSubscription(state, call)],
  ['GET /checkout/*', (state, call) => [200, checkoutPage(state, at(call, 1))]],
  [
    'POST /checkout/*',
    async (state, call) =>
      isPayment(state.payments, at(call, 1))
        ? payNow(state.payments, at(call, 1))
        : pay(state, at(call, 1)),
  ],
  ['GET /portal/*', (state, call) => [200, portalPage(call.query.get('return') ?? state.url)]],
  ['POST /fake/hold', (state) => hold(state)],
  ['GET /fake/stripe.js', () => [200, new Script(STRIPE_JS)]],
  [
    'GET /fake/elements/*',
    async (state, call) =>
      composedCall(state.fake, { session: at(call, 2), action: at(call, 3) }, call.form),
  ],
  [
    'POST /fake/elements/*/*',
    async (state, call) =>
      composedCall(state.fake, { session: at(call, 2), action: at(call, 3) }, call.form),
  ],
  [
    'POST /fake/promotions/*',
    (state, call) => {
      state.fake.books.promotions.set(at(call, 2), Number(call.form.get('percent_off') ?? '100'));
      return [200, { code: at(call, 2) }];
    },
  ],
  [
    'POST /fake/started/*',
    async (state, call) => restart(state.fake.ledger, at(call, 2), call.form),
  ],
  ['POST /fake/past-due/*', async (state, call) => pastDue(state, at(call, 2))],
  ['POST /fake/release', async (state) => release(state)],
  ['GET /fake/deleted/*', async (state, call) => whenDeleted(state, at(call, 2))],
  [
    'POST /fake/expire/*',
    (state, call) => expirePayment(state.payments, at(call, 2), call.query.get('silent') !== '1'),
  ],
  ['POST /fake/pay-async/*', (state, call) => payLater(state.payments, at(call, 2))],
  ['POST /fake/async/*/*', (state, call) => settle(state.payments, at(call, 2), at(call, 3))],
  ['POST /fake/refund/*', (state, call) => dashboardRefund(state.payments, at(call, 2))],
  [
    'GET /fake/delivered/*/*',
    async (state, call) => whenDelivered(state.payments, at(call, 2), at(call, 3)),
  ],
  [
    'POST /fake/redeliver/*/*',
    async (state, call) => redeliver(state.payments, at(call, 2), at(call, 3)),
  ],
];

const route = async (state: State, request: IncomingMessage, url: URL): Promise<Reply> => {
  const segments = url.pathname.split('/').slice(1);
  const key = `${request.method ?? 'GET'} /${segments.join('/')}`;
  const found = ROUTES.find(([pattern]) => routeMatches(pattern, key));
  if (found === undefined) {
    return missing;
  }
  const idempotency = request.headers['idempotency-key'];
  const form = await formOf(request);
  const call = {
    segments,
    form,
    query: url.searchParams,
    idempotency: typeof idempotency === 'string' ? idempotency : undefined,
  };
  return found[1](state, call);
};

class Page {
  public readonly html: string;

  public constructor(html: string) {
    this.html = html;
  }
}

const attribute = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** The hosted billing portal: the member goes back by its link, as at Stripe, never sent back
 *  unasked (a bounce, to Firefox). */
const portalPage = (back: string): Page =>
  new Page(
    `<!doctype html><html lang="en"><title>Billing portal</title><main><h1>Billing portal</h1>` +
      `<a href="${attribute(back)}">Back</a></main></html>`,
  );

/** The hosted Checkout page: the buyer presses Pay or goes back unpaid to `cancel_url`, as at
 *  Stripe, since a page that sent the browser straight back would be flagged as a bounce tracker. */
const checkoutPage = (state: State, session: string): Page => {
  const form = state.sessions.get(session) ?? paymentForm(state.payments, session);
  const back = (form === undefined ? undefined : form.get('cancel_url')) ?? '/';
  return new Page(
    `<!doctype html><html lang="en"><title>Checkout</title><main><h1>Checkout</h1>` +
      `<a href="${attribute(back)}">Back</a>` +
      `<form method="post" action="/checkout/${encodeURIComponent(session)}">` +
      `<button type="submit">Pay</button></form></main></html>`,
  );
};

const respond = (response: ServerResponse, [status, body, location]: Reply): void => {
  if (body instanceof Page) {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body.html);
    return;
  }
  if (body instanceof Script) {
    response.writeHead(status, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(body.source);
    return;
  }
  response.writeHead(
    status,
    location === undefined ? { 'content-type': 'application/json' } : { location },
  );
  response.end(JSON.stringify(body));
};

export interface FakeStripeOptions {
  readonly plans: readonly Plan[];
  /** Where Stripe would send its webhooks. */
  readonly webhookUrl: string;
}

/** The fake's state, empty, with the ledger its subscriptions share. */
const stateOf = (url: string, options: FakeStripeOptions, secret: string): State => {
  const webhook = { url: options.webhookUrl, secret };
  const plans = new Map(options.plans.map((plan) => [plan.id, plan]));
  const [customers, subscriptions] = [new Map<string, Customer>(), new Map<string, Subscription>()];
  const payments = paymentsOf(url, webhook);
  const ledger: Ledger = {
    url,
    plans,
    customers,
    subscriptions,
    payments,
    announce: async (type, object) => announce(state, type, object),
  };
  const state: State = {
    url,
    plans,
    customers,
    sessions: new Map(),
    subscriptions,
    deleted: new EventTarget(),
    webhook,
    held: undefined,
    payments,
    fake: { ledger, books: subscriptionsOf() },
  };
  return state;
};

/** A Stripe answering from memory only what the backend asks of it, with signed webhooks; tests
 *  steer it, and the one-time payments of stripe-payments.ts, through the `/fake/` routes. */
export const startFakeStripe = async (options: FakeStripeOptions): Promise<FakeStripe> => {
  const webhookSecret = `whsec_${randomUUID()}`;
  const server = createServer({ keepAliveTimeout: IDLE_CONNECTION_MS });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  const state = stateOf(url, options, webhookSecret);
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    route(state, request, new URL(request.url ?? '/', url))
      .then((reply) => {
        respond(response, reply);
      })
      .catch((error: unknown) => {
        respond(response, [502, { error: { message: described(error) } }]);
      });
  });
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  const prices = new Map(options.plans.map((plan) => [plan.id, plan.id]));
  return {
    url,
    secretKey: `sk_test_${randomUUID()}`,
    publishableKey: `pk_test_${randomUUID()}`,
    webhookSecret,
    prices,
    stop,
  };
};
