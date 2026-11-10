// The fake Stripe's subscriptions: started from a hosted Checkout or from Checkout Sessions in
// `elements` mode (a page's Stripe.js composing the payment), each with its first invoice, and
// ended at once with that invoice refunded, as a withdrawal ends one.
import { randomUUID } from 'node:crypto';

import { DECLINED_CARD } from './stripe-js.ts';
import { id, missing, type Payments, refund, type Reply } from './stripe-payments.ts';

/** A recurring price as the fake offers it: minor units per lowercase currency code. */
export interface Plan {
  readonly id: string;
  readonly interval: 'month' | 'year';
  readonly amounts: Readonly<Record<string, number>>;
}

export interface Customer {
  readonly id: string;
  readonly email: string | null;
}

export interface Subscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  start_date: number;
  latest_invoice: string;
  items: {
    data: {
      current_period_end: number;
      price: {
        id: string;
        currency: string;
        unit_amount: number;
        recurring: { interval: string };
      };
    }[];
  };
}

/** A subscription's first invoice: paid through a payment intent unless nothing was due. */
interface Invoice {
  readonly id: string;
  readonly intent: string | undefined;
  readonly amount: number;
  readonly currency: string;
  refunded: boolean;
}

/** A Checkout Session in `elements` mode. */
interface Composed {
  readonly id: string;
  readonly form: URLSearchParams;
  email: string | undefined;
  /** What a promotion code takes off, in percent, once one is applied. */
  percentOff: number;
  status: 'open' | 'complete';
}

/** What the subscriptions share with the rest of the fake. */
export interface Ledger {
  readonly url: string;
  readonly plans: ReadonlyMap<string, Plan>;
  readonly customers: Map<string, Customer>;
  readonly subscriptions: Map<string, Subscription>;
  readonly payments: Payments;
  /** Says a subscription changed, as a webhook. */
  readonly announce: (type: string, object: Subscription) => Promise<void>;
}

export interface Subscriptions {
  readonly invoices: Map<string, Invoice>;
  readonly composed: Map<string, Composed>;
  /** Promotion codes tests made, each with what it takes off, in percent. */
  readonly promotions: Map<string, number>;
}

/** The subscriptions' state and what they share with the rest of the fake. */
export interface Fake {
  readonly ledger: Ledger;
  readonly books: Subscriptions;
}

export const subscriptionsOf = (): Subscriptions => ({
  invoices: new Map(),
  composed: new Map(),
  promotions: new Map(),
});

const SECONDS_PER = { month: 30 * 86_400, year: 365 * 86_400 } as const;

const planOf = (ledger: Ledger, form: URLSearchParams): Plan | undefined =>
  ledger.plans.get(form.get('line_items[0][price]') ?? '');

/** The currency a buyer is charged in: euros where the price has them, as for a buyer in
 *  Portugal, else the price's first. */
const currencyOf = (plan: Plan): string =>
  'eur' in plan.amounts ? 'eur' : (Object.keys(plan.amounts)[0] ?? 'eur');

const dueOf = (amount: number, percentOff: number): number =>
  Math.round((amount * (100 - percentOff)) / 100);

/** What a plan costs a buyer: its currency, its listed amount, and what is due after any
 *  promotion. */
interface Price {
  readonly currency: string;
  readonly listed: number;
  readonly due: number;
}

const priceOf = (plan: Plan, percentOff: number): Price => {
  const currency = currencyOf(plan);
  const listed = plan.amounts[currency] ?? 0;
  return { currency, listed, due: dueOf(listed, percentOff) };
};

/** A subscription to `plan` from now, renewing each interval at its listed price. */
const subscriptionOf = (
  plan: Plan,
  { currency, listed }: Price,
  { customer, invoice }: { readonly customer: string; readonly invoice: string },
): Subscription => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: id('sub'),
    customer,
    status: 'active',
    cancel_at_period_end: false,
    start_date: now,
    latest_invoice: invoice,
    items: {
      data: [
        {
          current_period_end: now + SECONDS_PER[plan.interval],
          price: {
            id: plan.id,
            currency,
            unit_amount: listed,
            recurring: { interval: plan.interval },
          },
        },
      ],
    },
  };
};

/** Starts the subscription a paid session asked for, and says so as Stripe does. */
export const subscribe = async (
  { ledger, books }: Fake,
  form: URLSearchParams,
  percentOff = 0,
): Promise<boolean> => {
  const plan = planOf(ledger, form);
  if (plan === undefined) {
    return false;
  }
  const price = priceOf(plan, percentOff);
  const invoice: Invoice = {
    id: id('in'),
    intent: price.due > 0 ? id('pi') : undefined,
    amount: price.due,
    currency: price.currency,
    refunded: false,
  };
  books.invoices.set(invoice.id, invoice);
  const customer = form.get('customer') ?? '';
  const subscription = subscriptionOf(plan, price, { customer, invoice: invoice.id });
  ledger.subscriptions.set(subscription.id, subscription);
  await ledger.announce('customer.subscription.created', subscription);
  return true;
};

/** A session the page composes itself: its client secret is its id, then `_secret_`. */
export const compose = (books: Subscriptions, form: URLSearchParams): Reply => {
  const session = id('cs');
  books.composed.set(session, {
    id: session,
    form,
    email: undefined,
    percentOff: 0,
    status: 'open',
  });
  const secret = `${session}_secret_${randomUUID().replaceAll('-', '')}`;
  return [200, { id: session, client_secret: secret, ui_mode: 'elements' }];
};

const formatted = (minor: number, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);

const emailOf = (ledger: Ledger, session: Composed): string | undefined => {
  const customer = ledger.customers.get(session.form.get('customer') ?? '');
  const held = customer === undefined ? undefined : customer.email;
  return session.email ?? held ?? undefined;
};

/** The session as Stripe.js shows it: what is due now and on each renewal. */
const viewOf = (ledger: Ledger, session: Composed): object | undefined => {
  const plan = planOf(ledger, session.form);
  if (plan === undefined) {
    return undefined;
  }
  const { currency, listed, due } = priceOf(plan, session.percentOff);
  const amount = (minor: number): { amount: string; minorUnitsAmount: number } => ({
    amount: formatted(minor, currency),
    minorUnitsAmount: minor,
  });
  const discounts =
    session.percentOff === 0
      ? []
      : [
          Object.assign(amount(listed - due), {
            displayName: 'Promotion',
            percentOff: session.percentOff,
          }),
        ];
  return {
    id: session.id,
    status: { type: session.status },
    email: emailOf(ledger, session) ?? '',
    currency,
    minorUnitsAmountDivisor: 100,
    total: { subtotal: amount(listed), discount: amount(listed - due), total: amount(due) },
    recurring: { interval: plan.interval, intervalCount: 1 },
    discountAmounts: discounts,
    canConfirm: true,
  };
};

const view = (ledger: Ledger, session: Composed): Reply => {
  const shown = viewOf(ledger, session);
  return shown === undefined ? missing : [200, shown];
};

/** An action that went through, as Stripe.js resolves it: the session as it now stands. */
const through = (ledger: Ledger, session: Composed, extra: object = {}): Reply => {
  const shown = viewOf(ledger, session);
  if (shown === undefined) {
    return missing;
  }
  const done = { type: 'success', session: shown };
  return [200, Object.assign(done, extra)];
};

/** A request Stripe's API refuses, as it answers one. */
const invalid = (code: string, message: string): Reply => [
  400,
  { error: { type: 'invalid_request_error', code, message } },
];

/** A buyer's mistake or a declined card, as Stripe.js resolves it: an answer the page shows, never
 *  a failed request, which a browser would log as a fault of the page. */
const refused = (error: object): Reply => [200, { type: 'error', error }];

/** Why Stripe.js refuses the card typed, if it does: too short, or the test card it declines. */
const cardRefusal = (form: URLSearchParams): Reply | undefined => {
  const card = (form.get('card') ?? '').replaceAll(' ', '');
  if (form.get('wallet') === null && card.length < 12) {
    return refused({ message: 'Your card number is incomplete.' });
  }
  if (card === DECLINED_CARD) {
    const declined = { declineCode: 'card_declined' };
    return refused({
      code: 'paymentFailed',
      message: 'Your card was declined.',
      paymentFailed: declined,
    });
  }
  return undefined;
};

const confirm = async (fake: Fake, session: Composed, form: URLSearchParams): Promise<Reply> => {
  const { ledger } = fake;
  const email = form.get('email') ?? emailOf(ledger, session);
  if (email === undefined || email === '') {
    return refused({ message: 'Enter your email address.' });
  }
  const refusal = cardRefusal(form);
  if (refusal !== undefined) {
    return refusal;
  }
  const customer = ledger.customers.get(session.form.get('customer') ?? '');
  if (customer !== undefined) {
    ledger.customers.set(customer.id, { id: customer.id, email: customer.email ?? email });
  }
  if (!(await subscribe(fake, session.form, session.percentOff))) {
    return missing;
  }
  session.status = 'complete';
  return through(ledger, session, { return_url: session.form.get('return_url') ?? ledger.url });
};

/** Sets a session's promotion from its code, none for an empty one. An unknown code is refused. */
const promoted = (
  books: Subscriptions,
  session: Composed,
  form: URLSearchParams,
): Reply | undefined => {
  const code = form.get('code') ?? '';
  const off = books.promotions.get(code);
  if (code !== '' && off === undefined) {
    return refused({ code: 'invalidCode', message: 'This code is invalid.' });
  }
  session.percentOff = off ?? 0;
  return undefined;
};

/** What a page's Stripe.js asks of a session: read it, set its email or promotion code, or
 *  confirm it with the card typed or with a wallet. An action answers as Stripe.js resolves. */
export const composedCall = async (
  fake: Fake,
  { session: sessionId, action }: { readonly session: string; readonly action: string },
  form: URLSearchParams,
): Promise<Reply> => {
  const { ledger, books } = fake;
  const session = books.composed.get(sessionId);
  if (session === undefined) {
    return missing;
  }
  if (action === 'email') {
    session.email = form.get('email') ?? undefined;
  }
  const refusal = action === 'promotion' ? promoted(books, session, form) : undefined;
  if (refusal !== undefined) {
    return refusal;
  }
  if (action === 'confirm') {
    return confirm(fake, session, form);
  }
  return action === '' ? view(ledger, session) : through(ledger, session);
};

/** Cancels at once, as `DELETE /v1/subscriptions/:id` does: a withdrawal, not a lapse. */
export const cancelNow = async (ledger: Ledger, subscriptionId: string): Promise<Reply> => {
  const found = ledger.subscriptions.get(subscriptionId);
  if (found === undefined) {
    return missing;
  }
  if (found.status !== 'canceled') {
    found.status = 'canceled';
    await ledger.announce('customer.subscription.deleted', found);
  }
  return [200, found];
};

/** An invoice with its payments, as `?expand[]=payments` returns them. */
export const invoiceOf = (books: Subscriptions, invoiceId: string): Reply => {
  const found = books.invoices.get(invoiceId);
  if (found === undefined) {
    return missing;
  }
  const paid = { type: 'payment_intent', payment_intent: found.intent };
  const payments = found.intent === undefined ? [] : [{ status: 'paid', payment: paid }];
  const shown = { id: found.id, amount_paid: found.amount, currency: found.currency };
  return [200, Object.assign(shown, { payments: { data: payments } })];
};

/** Refunds an invoice's payment in full, or else a one-time payment: whichever holds the
 *  intent. A repeat under the same idempotency key answers the same refund. */
export const refundIntent = (
  { ledger, books }: Fake,
  form: URLSearchParams,
  key: string | undefined,
): Reply => {
  const intent = form.get('payment_intent') ?? '';
  const paid = [...books.invoices.values()].find((each) => each.intent === intent);
  if (paid === undefined) {
    return refund(ledger.payments, intent, key);
  }
  if (paid.refunded && key === undefined) {
    return invalid('charge_already_refunded', 'This charge has already been refunded.');
  }
  paid.refunded = true;
  const made = { id: `re_${intent}`, object: 'refund', amount: paid.amount };
  return [200, Object.assign(made, { currency: paid.currency, payment_intent: intent })];
};

/** Moves a subscription's start, so a test can stand past a window that counts from it. */
export const restart = async (
  ledger: Ledger,
  subscriptionId: string,
  form: URLSearchParams,
): Promise<Reply> => {
  const found = ledger.subscriptions.get(subscriptionId);
  if (found === undefined) {
    return missing;
  }
  found.start_date = Number(form.get('start_date') ?? found.start_date);
  await ledger.announce('customer.subscription.updated', found);
  return [200, found];
};
