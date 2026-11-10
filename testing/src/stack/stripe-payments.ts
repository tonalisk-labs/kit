// The fake Stripe's one-time payments (Checkout `mode=payment`) and refunds. As Stripe does, a
// webhook is sent after the reply, never awaited by it; each delivery is recorded for tests.
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';

export type Reply = readonly [status: number, body: unknown, location?: string];

export const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

export const missing: Reply = [
  404,
  { error: { type: 'invalid_request_error', code: 'resource_missing' } },
];

const refused = (code: string): Reply => [400, { error: { type: 'invalid_request_error', code } }];

/** Signs as Stripe does: HMAC-SHA256 over `"{t}.{payload}"`, sent as `t=…,v1=…`. */
export const signature = (payload: string, secret: string): string => {
  const time = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', secret).update(`${time}.${payload}`).digest('hex');
  return `t=${time},v1=${digest}`;
};

/** Stripe's shortest Checkout life, which a session's `expires_at` must leave. */
const MIN_LIFE_SECONDS = 30 * 60;

interface Payment {
  readonly id: string;
  readonly form: URLSearchParams;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid';
  intent: string | undefined;
  charge: string | undefined;
  method: string;
  refunded: number;
}

interface Delivery {
  readonly payload: string;
  /** The webhook's answer; 0 when it could not be reached. */
  readonly status: number;
}

export interface Payments {
  readonly url: string;
  readonly webhook: { readonly url: string; readonly secret: string };
  readonly sessions: Map<string, Payment>;
  /** Idempotency keys, each with the form it came with and the reply it got. */
  readonly keyed: Map<string, { readonly form: string; readonly reply: Reply }>;
  /** Deliveries by `<event type>/<session>`. */
  readonly delivered: Map<string, Delivery[]>;
  readonly arrived: EventTarget;
}

export const paymentsOf = (url: string, webhook: Payments['webhook']): Payments => ({
  url,
  webhook,
  sessions: new Map(),
  keyed: new Map(),
  delivered: new Map(),
  arrived: new EventTarget(),
});

const total = (payment: Payment): number =>
  Number(payment.form.get('line_items[0][price_data][unit_amount]') ?? '0');

const chargeOf = (payments: Payments, payment: Payment): Record<string, unknown> => ({
  id: payment.charge,
  object: 'charge',
  payment_intent: payment.intent,
  amount: total(payment),
  amount_refunded: payment.refunded,
  refunded: payment.refunded >= total(payment),
  receipt_url: `${payments.url}/receipts/${payment.id}`,
  payment_method_details: { type: payment.method },
});

/** The session as Stripe answers it; `expand` hands over its intent and latest charge. */
const sessionOf = (payments: Payments, payment: Payment, expand = false): unknown => {
  const { form } = payment;
  // An absent member is left out of the JSON, as Stripe's null reads to a client.
  const intent =
    payment.intent === undefined || !expand
      ? payment.intent
      : { id: payment.intent, latest_charge: chargeOf(payments, payment) };
  return {
    id: payment.id,
    object: 'checkout.session',
    mode: 'payment',
    status: payment.status,
    payment_status: payment.paymentStatus,
    client_reference_id: form.get('client_reference_id'),
    url: payment.status === 'open' ? `${payments.url}/checkout/${payment.id}` : undefined,
    expires_at: Number(form.get('expires_at')),
    amount_total: total(payment),
    currency: form.get('line_items[0][price_data][currency]'),
    customer_email: form.get('customer_email'),
    customer_details: { email: form.get('customer_email') },
    payment_method_types: [...form]
      .filter(([key]) => key.startsWith('payment_method_types['))
      .map(([, value]) => value),
    metadata: { event: form.get('metadata[event]'), type: form.get('metadata[type]') },
    payment_intent: intent,
  };
};

const record = (payments: Payments, key: string, delivery: Delivery): void => {
  payments.delivered.set(key, [...(payments.delivered.get(key) ?? []), delivery]);
  payments.arrived.dispatchEvent(new Event(key));
};

const send = async (payments: Payments, payload: string): Promise<number> => {
  const response = await fetch(payments.webhook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature(payload, payments.webhook.secret),
    },
    body: payload,
  });
  await response.arrayBuffer();
  return response.status;
};

/** Sends an event after the reply, as Stripe does, and records how the webhook answered. A
 *  charge's event carries the charge; every other, the session. */
const announce = (payments: Payments, type: string, payment: Payment): void => {
  const object =
    type === 'charge.refunded' ? chargeOf(payments, payment) : sessionOf(payments, payment);
  const payload = JSON.stringify({ id: id('evt'), type, data: { object } });
  const key = `${type}/${payment.id}`;
  send(payments, payload).then(
    (status) => {
      record(payments, key, { payload, status });
    },
    (error: unknown) => {
      console.error(`the fake Stripe could not deliver ${type}:`, error);
      record(payments, key, { payload, status: 0 });
    },
  );
};

/** A repeated key answers what it answered, and refuses another form, as Stripe does. */
const replayed = (payments: Payments, key: string | undefined, form: string): Reply | undefined => {
  const earlier = key === undefined ? undefined : payments.keyed.get(key);
  if (earlier === undefined) {
    return undefined;
  }
  return earlier.form === form ? earlier.reply : refused('idempotency_key_in_use');
};

const remember = (
  payments: Payments,
  { key, form }: { readonly key: string | undefined; readonly form: string },
  reply: Reply,
): Reply => {
  if (key !== undefined) {
    payments.keyed.set(key, { form, reply });
  }
  return reply;
};

export const createPayment = (
  payments: Payments,
  form: URLSearchParams,
  key: string | undefined,
): Reply => {
  const sent = form.toString();
  const earlier = replayed(payments, key, sent);
  if (earlier !== undefined) {
    return earlier;
  }
  const life = Number(form.get('expires_at')) - Math.floor(Date.now() / 1000);
  if (
    !(life >= MIN_LIFE_SECONDS) ||
    !(form.get('success_url') ?? '').includes('{CHECKOUT_SESSION_ID}')
  ) {
    return refused('parameter_invalid');
  }
  const payment: Payment = {
    id: id('cs_test'),
    form,
    status: 'open',
    paymentStatus: 'unpaid',
    intent: undefined,
    charge: undefined,
    method: form.get('payment_method_types[0]') ?? 'card',
    refunded: 0,
  };
  payments.sessions.set(payment.id, payment);
  return remember(payments, { key, form: sent }, [200, sessionOf(payments, payment)]);
};

export const readPayment = (payments: Payments, session: string, expand: boolean): Reply => {
  const payment = payments.sessions.get(session);
  return payment === undefined ? missing : [200, sessionOf(payments, payment, expand)];
};

/** An open session expires; `notify` false leaves Stripe's webhook unsent, as if lost. */
export const expirePayment = (payments: Payments, session: string, notify = true): Reply => {
  const payment = payments.sessions.get(session);
  if (payment === undefined) {
    return missing;
  }
  if (payment.status !== 'open') {
    return refused('checkout_session_not_open');
  }
  payment.status = 'expired';
  if (notify) {
    announce(payments, 'checkout.session.expired', payment);
  }
  return [200, sessionOf(payments, payment)];
};

const successOf = (payment: Payment): string =>
  (payment.form.get('success_url') ?? '').replace('{CHECKOUT_SESSION_ID}', payment.id);

/** The buyer pays at Checkout, by `method`, now or (an `unpaid` session) later. */
const complete = (
  payments: Payments,
  session: string,
  { method, paid }: { readonly method: string; readonly paid: boolean },
): Reply => {
  const payment = payments.sessions.get(session);
  if (payment === undefined) {
    return missing;
  }
  if (payment.status !== 'open') {
    return refused('checkout_session_not_open');
  }
  Object.assign(payment, {
    status: 'complete',
    paymentStatus: paid ? 'paid' : 'unpaid',
    intent: id('pi'),
    charge: id('ch'),
    method,
  });
  announce(payments, 'checkout.session.completed', payment);
  return [303, {}, successOf(payment)];
};

export const isPayment = (payments: Payments, session: string): boolean =>
  payments.sessions.has(session);

export const payNow = (payments: Payments, session: string): Reply =>
  complete(payments, session, { method: 'card', paid: true });

export const payLater = (payments: Payments, session: string): Reply =>
  complete(payments, session, { method: 'mb_way', paid: false });

/** A payment session's form, for the Checkout page's way back. */
export const paymentForm = (payments: Payments, session: string): URLSearchParams | undefined => {
  const payment = payments.sessions.get(session);
  return payment === undefined ? undefined : payment.form;
};

/** A delayed payment settles: `succeed` or `fail`. */
export const settle = (payments: Payments, session: string, outcome: string): Reply => {
  const payment = payments.sessions.get(session);
  if (payment === undefined) {
    return missing;
  }
  if (payment.status !== 'complete' || payment.paymentStatus === 'paid') {
    return refused('payment_intent_unexpected_state');
  }
  if (outcome === 'succeed') {
    payment.paymentStatus = 'paid';
  }
  const type = outcome === 'succeed' ? 'async_payment_succeeded' : 'async_payment_failed';
  announce(payments, `checkout.session.${type}`, payment);
  return [200, sessionOf(payments, payment)];
};

/** Refunds what is left of a payment, as `POST /v1/refunds` or the Dashboard does. */
export const refund = (payments: Payments, intent: string, key?: string): Reply => {
  const earlier = replayed(payments, key, intent);
  if (earlier !== undefined) {
    return earlier;
  }
  const payment = [...payments.sessions.values()].find((each) => each.intent === intent);
  if (payment === undefined) {
    return missing;
  }
  const amount = total(payment) - payment.refunded;
  if (amount <= 0) {
    return refused('charge_already_refunded');
  }
  payment.refunded = total(payment);
  announce(payments, 'charge.refunded', payment);
  const reply: Reply = [200, { id: id('re'), object: 'refund', amount, payment_intent: intent }];
  return remember(payments, { key, form: intent }, reply);
};

export const dashboardRefund = (payments: Payments, session: string): Reply => {
  const payment = payments.sessions.get(session);
  if (payment === undefined) {
    return missing;
  }
  return payment.intent === undefined ? missing : refund(payments, payment.intent);
};

/** Resolves once `type` was delivered for the session: an event, bounded by the caller's own
 *  timeout. Answers each delivery's status, in order. */
export const whenDelivered = async (
  payments: Payments,
  type: string,
  session: string,
): Promise<Reply> => {
  const key = `${type}/${session}`;
  if (!payments.delivered.has(key)) {
    await once(payments.arrived, key);
  }
  const statuses = (payments.delivered.get(key) ?? []).map(({ status }) => status);
  return [200, { statuses }];
};

/** Sends the last `type` event of the session again, as Stripe's retries do, awaited. */
export const redeliver = async (
  payments: Payments,
  type: string,
  session: string,
): Promise<Reply> => {
  const last = (payments.delivered.get(`${type}/${session}`) ?? []).at(-1);
  if (last === undefined) {
    return missing;
  }
  const status = await send(payments, last.payload);
  record(payments, `${type}/${session}`, { payload: last.payload, status });
  return [200, { status }];
};
