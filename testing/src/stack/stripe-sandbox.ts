import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { isObject } from '../unknown.ts';
import { run, serve, type Service, which } from './process.ts';
import type { Plan } from './stripe.ts';

/** The variable that opts a run into the real Stripe sandbox instead of the fake. */
const SANDBOX_ENV = 'STRIPE_SANDBOX';

/** The sandbox's secret key, a test-mode key of the Stripe account the run may use. */
const KEY_ENV = 'STRIPE_SANDBOX_SECRET_KEY';

/** Its publishable key, which a page initialises Stripe.js with. */
const PUBLISHABLE_ENV = 'STRIPE_SANDBOX_PUBLISHABLE_KEY';

const API = 'https://api.stripe.com';

/** Where the harness's prices are found again: one per plan, created once per account. */
const LOOKUP_PREFIX = 'sites-testing-';

/** How `stripe listen` names an event it receives: `--> customer.deleted [evt_…]`. */
const RECEIVED = /-->\s+(?<type>[\w.]+)\s+\[(?<event>evt_\w+)\]/u;

export interface StripeSandbox extends Service {
  /** The API base the backend is pointed at: Stripe's own. */
  readonly url: string;
  readonly secretKey: string;
  readonly publishableKey: string;
  /** The secret `stripe listen` signs every forwarded event with. */
  readonly webhookSecret: string;
  /** The sandbox price of each plan, by the plan's id. */
  readonly prices: ReadonlyMap<string, string>;
  /** Answers `GET /events/<type>/<object id>` with the object once such an event arrived. */
  readonly watch: string;
}

export const sandboxRequested = (): boolean => process.env[SANDBOX_ENV] === '1';

/** What a sandbox run needs before it can reach Stripe at all. */
export const sandboxMissing = (): string[] => [
  ...(process.env[KEY_ENV] === undefined ? [KEY_ENV] : []),
  ...(process.env[PUBLISHABLE_ENV] === undefined ? [PUBLISHABLE_ENV] : []),
  ...(which('stripe') === undefined ? ['the stripe CLI on PATH'] : []),
];

const listOf = (reply: unknown): Record<string, unknown>[] =>
  isObject(reply) && Array.isArray(reply['data']) ? reply['data'].filter(isObject) : [];

const stripeApi =
  (key: string, signal: AbortSignal) =>
  async (method: 'GET' | 'POST', route: string, form?: URLSearchParams): Promise<unknown> => {
    const headers = { authorization: `Bearer ${key}` };
    const response = await fetch(
      `${API}${route}`,
      form === undefined ? { headers, signal } : { method, headers, body: form, signal },
    );
    const reply: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Stripe answered ${String(response.status)} to ${method} ${route}`, {
        cause: reply,
      });
    }
    return reply;
  };

type StripeApi = ReturnType<typeof stripeApi>;

/** A recurring price for `plan` in each of its currencies, the first being its default. */
const priceForm = (plan: Plan): URLSearchParams => {
  const [[currency, amount] = ['', 0], ...others] = Object.entries(plan.amounts);
  return new URLSearchParams([
    ['lookup_key', `${LOOKUP_PREFIX}${plan.id}`],
    ['product_data[name]', `Journeys ${plan.id}`],
    ['recurring[interval]', plan.interval],
    ['currency', currency],
    ['unit_amount', String(amount)],
    ...others.map(([other, minor]) => [`currency_options[${other}][unit_amount]`, String(minor)]),
  ]);
};

/** The sandbox's price per plan: found by its lookup key, or created on the first run. */
const pricesFor = async (
  call: StripeApi,
  plans: readonly Plan[],
): Promise<ReadonlyMap<string, string>> => {
  const query = new URLSearchParams([
    ['active', 'true'],
    ...plans.map((plan) => ['lookup_keys[]', `${LOOKUP_PREFIX}${plan.id}`]),
  ]);
  const found = listOf(await call('GET', `/v1/prices?${query.toString()}`));
  const entries = await Promise.all(
    plans.map(async (plan): Promise<[string, unknown]> => {
      const kept = found.find((price) => price['lookup_key'] === `${LOOKUP_PREFIX}${plan.id}`);
      const price = kept ?? (await call('POST', '/v1/prices', priceForm(plan)));
      return [plan.id, isObject(price) ? price['id'] : undefined];
    }),
  );
  return new Map(entries.map(([plan, id]) => [plan, typeof id === 'string' ? id : '']));
};

/** A portal session without a configuration needs the account's default, saved in the Dashboard. */
const requirePortal = async (call: StripeApi): Promise<void> => {
  const defaults = listOf(await call('GET', '/v1/billing_portal/configurations?is_default=true'));
  if (defaults.length === 0) {
    throw new Error(
      'the Stripe sandbox has no default customer portal: save one in the Dashboard, test mode',
    );
  }
};

interface Seen {
  readonly objects: Map<string, unknown>;
  readonly arrived: EventTarget;
}

/** Records an event `stripe listen` received, read back from Stripe for the object it names. */
const record = async (
  call: StripeApi,
  seen: Seen,
  { type, event }: { readonly type: string; readonly event: string },
): Promise<void> => {
  const reply = await call('GET', `/v1/events/${event}`);
  const data = isObject(reply) ? reply['data'] : undefined;
  const object = isObject(data) ? data['object'] : undefined;
  const id = isObject(object) ? object['id'] : undefined;
  if (typeof id === 'string') {
    seen.objects.set(`${type}/${id}`, object);
    seen.arrived.dispatchEvent(new Event(`${type}/${id}`));
  }
};

const hear =
  (call: StripeApi, seen: Seen) =>
  (line: string): void => {
    const found = RECEIVED.exec(line);
    const { type, event } = found === null ? {} : (found.groups ?? {});
    if (type !== undefined && event !== undefined) {
      record(call, seen, { type, event }).catch((error: unknown) => {
        console.error(`could not read Stripe event ${event}:`, error);
      });
    }
  };

/** Answers once the event arrived: an event, bounded by the caller's own timeout. */
const answer = async (
  seen: Seen,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const [, route = '', type = '', id = ''] = (request.url ?? '').split('/');
  if (request.method !== 'GET' || route !== 'events') {
    response.writeHead(404).end();
    return;
  }
  const key = `${decodeURIComponent(type)}/${decodeURIComponent(id)}`;
  if (!seen.objects.has(key)) {
    await once(seen.arrived, key);
  }
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify(seen.objects.get(key)));
};

const startWatch = async (seen: Seen): Promise<Service & { readonly url: string }> => {
  const server = createServer((request, response) => {
    answer(seen, request, response).catch((error: unknown) => {
      response.writeHead(502).end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const stop = async (): Promise<void> => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  return { url: `http://127.0.0.1:${String(port)}`, stop };
};

export interface StripeSandboxOptions {
  readonly plans: readonly Plan[];
  /** Where `stripe listen` forwards every event of the account. */
  readonly webhookUrl: string;
  readonly signal: AbortSignal;
}

/** The sandbox's two keys, or what a run lacks to reach it. */
const keysOf = (): { readonly key: string; readonly publishableKey: string } => {
  const missing = sandboxMissing();
  const [key, publishableKey] = [process.env[KEY_ENV], process.env[PUBLISHABLE_ENV]];
  if (missing.length > 0 || key === undefined || publishableKey === undefined) {
    throw new Error(
      `${SANDBOX_ENV}=1, but the sandbox cannot be reached: missing ${missing.join(', ')}`,
    );
  }
  return { key, publishableKey };
};

/** The plans' prices, once the portal they are managed in is found. A target that only takes
 *  one-time payments has no plans, so no prices and no portal. */
const provisioned = async (
  call: StripeApi,
  plans: readonly Plan[],
): Promise<ReadonlyMap<string, string>> => {
  if (plans.length === 0) {
    return new Map<string, string>();
  }
  const [prices] = await Promise.all([pricesFor(call, plans), requirePortal(call)]);
  return prices;
};

/** The real Stripe API in test mode (STRIPE_SANDBOX=1), with `stripe listen` forwarding its events.
 *  Its key stays off the process list, and it skips TLS checks, as it can't take kit's local CA. */
export const startStripeSandbox = async (options: StripeSandboxOptions): Promise<StripeSandbox> => {
  const { signal } = options;
  const { key, publishableKey } = keysOf();
  const call = stripeApi(key, signal);
  const prices = await provisioned(call, options.plans);
  const env = Object.assign(structuredClone(process.env), { STRIPE_API_KEY: key });
  const events = ['listen', '--all-snapshot'];
  const secret = await run('stripe', [...events, '--print-secret'], { signal, env });
  const seen: Seen = { objects: new Map(), arrived: new EventTarget() };
  const forward = [...events, '--skip-verify', '--forward-to', options.webhookUrl];
  const listen = await serve('stripe', forward, {
    ready: ['Ready!'],
    onLine: hear(call, seen),
    signal,
    env,
  });
  const watch = await startWatch(seen).catch(async (error: unknown) => {
    await listen.stop();
    throw error;
  });
  const stop = async (): Promise<void> => {
    try {
      await listen.stop();
    } finally {
      await watch.stop();
    }
  };
  return {
    url: API,
    secretKey: key,
    publishableKey,
    webhookSecret: secret.trim(),
    prices,
    watch: watch.url,
    stop,
  };
};
