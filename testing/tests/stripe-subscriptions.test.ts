import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { DECLINED_CARD, RELEASE_TRAIN } from '../src/stack/stripe-js.ts';
import { type FakeStripe, startFakeStripe } from '../src/stack/stripe.ts';
import { ask, field, type Stand, stand } from './stripe-stand.ts';

/** An elements session for a new customer, by its id. */
const composed = async (stripe: FakeStripe, email?: string): Promise<string> => {
  const customer = await ask(stripe, '/v1/customers', {
    fields: email === undefined ? {} : { email },
  });
  const session = await ask(stripe, '/v1/checkout/sessions', {
    fields: {
      mode: 'subscription',
      ui_mode: 'elements',
      customer: String(customer.body['id']),
      'line_items[0][price]': 'monthly',
      'line_items[0][quantity]': '1',
      return_url: 'https://app.test/?billing=success',
    },
  });
  const secret = String(session.body['client_secret']);
  assert.match(secret, /^cs_\w+_secret_\w+$/u);
  assert.equal(session.body['url'], undefined, 'an elements session has no hosted page');
  return secret.split('_secret_')[0] ?? '';
};

await test('an elements session shows its total and starts the subscription once confirmed', async () => {
  const { stripe, events, stop } = await stand();
  try {
    const session = await composed(stripe, 'buyer@example.test');
    const shown = await ask(stripe, `/fake/elements/${session}`);
    assert.equal(field(shown.body, 'total', 'total', 'amount'), '€4.00');
    assert.equal(field(shown.body, 'recurring', 'interval'), 'month');
    assert.equal(shown.body['email'], 'buyer@example.test');
    const paid = await ask(stripe, `/fake/elements/${session}/confirm`, {
      fields: { card: '4242 4242 4242 4242' },
    });
    assert.equal(paid.body['type'], 'success', 'Stripe.js resolves a payment that went through');
    assert.equal(field(paid.body, 'session', 'status', 'type'), 'complete');
    assert.equal(paid.body['return_url'], 'https://app.test/?billing=success');
    assert.deepEqual(events(), ['customer.subscription.created']);
  } finally {
    await stop();
  }
});

await test('a confirm is refused without an email, with a short card or with the declined card, as Stripe.js resolves a refusal', async () => {
  const { stripe, events, stop } = await stand();
  try {
    const session = await composed(stripe);
    const confirm = `/fake/elements/${session}/confirm`;
    const noEmail = await ask(stripe, confirm, { fields: { card: '4242424242424242' } });
    assert.equal(noEmail.status, 200, 'a refusal is an answer, not a failed request');
    assert.equal(noEmail.body['type'], 'error');
    assert.equal(field(noEmail.body, 'error', 'message'), 'Enter your email address.');
    await ask(stripe, `/fake/elements/${session}/email`, {
      fields: { email: 'late@example.test' },
    });
    const short = await ask(stripe, confirm, { fields: { card: '4242' } });
    assert.equal(field(short.body, 'error', 'message'), 'Your card number is incomplete.');
    const declined = await ask(stripe, confirm, { fields: { card: DECLINED_CARD } });
    assert.equal(field(declined.body, 'error', 'code'), 'paymentFailed');
    assert.equal(field(declined.body, 'error', 'paymentFailed', 'declineCode'), 'card_declined');
    assert.equal(field(declined.body, 'error', 'message'), 'Your card was declined.');
    assert.deepEqual(events(), [], 'nothing was started');
    const wallet = await ask(stripe, confirm, { fields: { wallet: 'link' } });
    assert.equal(wallet.body['type'], 'success', 'a wallet needs no card');
  } finally {
    await stop();
  }
});

await test('a promotion code a test made takes its share off, and an unknown one is refused', async () => {
  const { stripe, stop } = await stand();
  try {
    const session = await composed(stripe, 'buyer@example.test');
    const unknown = await ask(stripe, `/fake/elements/${session}/promotion`, {
      fields: { code: 'NOPE' },
    });
    assert.equal(field(unknown.body, 'error', 'code'), 'invalidCode');
    await ask(stripe, '/fake/promotions/HALF', { fields: { percent_off: '50' } });
    const half = await ask(stripe, `/fake/elements/${session}/promotion`, {
      fields: { code: 'HALF' },
    });
    assert.equal(field(half.body, 'session', 'total', 'total', 'amount'), '€2.00');
  } finally {
    await stop();
  }
});

/** A paid subscription, by its id, as the created event named it. */
const subscribed = async (fake: Stand): Promise<string> => {
  const session = await composed(fake.stripe, 'buyer@example.test');
  await ask(fake.stripe, `/fake/elements/${session}/confirm`, {
    fields: { card: '4242424242424242' },
  });
  const [created] = fake.heard;
  return String(field(created === undefined ? {} : created.object, 'id'));
};

await test('a withdrawal refunds the first invoice in full, once per key', async () => {
  const fake = await stand();
  try {
    const { stripe } = fake;
    const subscription = await subscribed(fake);
    const read = await ask(stripe, `/v1/subscriptions/${subscription}`);
    assert.equal(field(read.body, 'items', 'data', '0', 'price', 'unit_amount'), 400);
    const invoice = await ask(stripe, `/v1/invoices/${String(read.body['latest_invoice'])}`);
    const intent = String(
      field(invoice.body, 'payments', 'data', '0', 'payment', 'payment_intent'),
    );
    const refund = { fields: { payment_intent: intent }, key: `withdrawal-${subscription}` };
    const first = await ask(stripe, '/v1/refunds', refund);
    assert.equal(first.body['amount'], 400);
    const replayed = await ask(stripe, '/v1/refunds', refund);
    assert.equal(replayed.status, 200, 'the same key, the same refund');
    const again = await ask(stripe, '/v1/refunds', { fields: { payment_intent: intent } });
    assert.equal(field(again.body, 'error', 'code'), 'charge_already_refunded');
  } finally {
    await fake.stop();
  }
});

await test('a withdrawal cancels at once, and a moved start is said as a change', async () => {
  const fake = await stand();
  try {
    const { stripe } = fake;
    const subscription = await subscribed(fake);
    const moved = await ask(stripe, `/fake/started/${subscription}`, {
      fields: { start_date: '1' },
    });
    assert.equal(moved.body['start_date'], 1);
    const cancelled = await ask(stripe, `/v1/subscriptions/${subscription}`, { method: 'DELETE' });
    assert.equal(cancelled.body['status'], 'canceled');
    await ask(stripe, `/v1/subscriptions/${subscription}`, { method: 'DELETE' });
    assert.deepEqual(fake.events(), [
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
  } finally {
    await fake.stop();
  }
});

await test('the stand-in reports the release train the loader expects, as a script', async () => {
  const { stripe, stop } = await stand();
  try {
    const response = await fetch(`${stripe.url}/fake/stripe.js`);
    assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/u);
    const window: Record<string, unknown> = {};
    runInNewContext(await response.text(), { window, setTimeout, fetch, URLSearchParams });
    const made: unknown = window['Stripe'];
    assert.equal(typeof made, 'function');
    assert.equal(typeof made === 'function' ? Reflect.get(made, 'version') : '', RELEASE_TRAIN);
  } finally {
    await stop();
  }
});

await test('unknown sessions, subscriptions and invoices are missing, as at Stripe', async () => {
  const { stripe, stop } = await stand();
  try {
    const answers = await Promise.all([
      ask(stripe, '/fake/elements/cs_none'),
      ask(stripe, '/fake/elements/cs_none/confirm', { fields: { card: '4242424242424242' } }),
      ask(stripe, '/v1/subscriptions/sub_none', { method: 'DELETE' }),
      ask(stripe, '/v1/invoices/in_none'),
      ask(stripe, '/fake/started/sub_none', { fields: { start_date: '1' } }),
      ask(stripe, '/v1/refunds', { fields: { payment_intent: 'pi_none' } }),
    ]);
    assert.deepEqual(
      answers.map(({ status }) => status),
      [404, 404, 404, 404, 404, 404],
    );
  } finally {
    await stop();
  }
});

await test('a code that takes everything off leaves an invoice with nothing to refund', async () => {
  const fake = await stand();
  try {
    const { stripe } = fake;
    await ask(stripe, '/fake/promotions/FREE', { fields: { percent_off: '100' } });
    const session = await composed(stripe, 'buyer@example.test');
    const promotion = `/fake/elements/${session}/promotion`;
    const free = await ask(stripe, promotion, { fields: { code: 'FREE' } });
    assert.equal(field(free.body, 'session', 'total', 'total', 'minorUnitsAmount'), 0);
    assert.equal(field(free.body, 'session', 'discountAmounts', '0', 'percentOff'), 100);
    const removed = await ask(stripe, promotion, { fields: { code: '' } });
    assert.equal(field(removed.body, 'session', 'total', 'total', 'minorUnitsAmount'), 400);
    await ask(stripe, promotion, { fields: { code: 'FREE' } });
    await ask(stripe, `/fake/elements/${session}/confirm`, { fields: { wallet: 'link' } });
    const [created] = fake.heard;
    const invoice = String(field(created === undefined ? {} : created.object, 'latest_invoice'));
    const read = await ask(stripe, `/v1/invoices/${invoice}`);
    assert.deepEqual(field(read.body, 'payments', 'data'), []);
    assert.equal(read.body['amount_paid'], 0);
  } finally {
    await fake.stop();
  }
});

await test('a price with no euros is charged in its first currency, and a set email wins', async () => {
  const hook = await stand();
  const stripe = await startFakeStripe({
    plans: [{ id: 'monthly', interval: 'month', amounts: { usd: 450 } }],
    webhookUrl: `${hook.stripe.url}/none`,
  });
  try {
    const session = await composed(stripe, 'customer@example.test');
    await ask(stripe, `/fake/elements/${session}/email`, {
      fields: { email: 'typed@example.test' },
    });
    const shown = await ask(stripe, `/fake/elements/${session}`);
    assert.equal(field(shown.body, 'total', 'total', 'amount'), 'US$4.50');
    assert.equal(shown.body['email'], 'typed@example.test');
  } finally {
    await stripe.stop();
    await hook.stop();
  }
});

await test('the hosted Checkout pays by its Pay button, and a held webhook waits for release', async () => {
  const fake = await stand();
  try {
    const { stripe } = fake;
    const keyed = { fields: { email: 'hosted@example.test' }, key: 'customer-1' };
    const [first, second] = [
      await ask(stripe, '/v1/customers', keyed),
      await ask(stripe, '/v1/customers', keyed),
    ];
    assert.equal(first.body['id'], second.body['id'], 'a repeated key answers the same customer');
    const price = await ask(stripe, '/v1/prices/monthly');
    assert.equal(field(price.body, 'currency_options', 'eur', 'unit_amount'), 400);
    const session = await ask(stripe, '/v1/checkout/sessions', {
      fields: {
        mode: 'subscription',
        customer: String(first.body['id']),
        'line_items[0][price]': 'monthly',
        success_url: 'https://app.test/?billing=success',
        cancel_url: 'https://app.test/?billing=cancelled',
      },
    });
    const page = String(session.body['url']);
    const shown = await fetch(page);
    assert.match(await shown.text(), /<button type="submit">Pay<\/button>/u);
    await ask(stripe, '/fake/hold', { fields: {} });
    const paid = await fetch(page, { method: 'POST', redirect: 'manual' });
    assert.equal(paid.headers.get('location'), 'https://app.test/?billing=success');
    assert.deepEqual(fake.events(), [], 'held');
    await ask(stripe, '/fake/release', { fields: {} });
    assert.deepEqual(fake.events(), ['customer.subscription.created']);
  } finally {
    await fake.stop();
  }
});

await test('a checkout paid twice at once subscribes once, the second pay finding it gone', async () => {
  // The first subscription's event is answered once the second pay has been, or has subscribed too.
  const answered = Promise.withResolvers<unknown>();
  const fake = await stand(async (heard) => {
    if (heard.length > 1) {
      answered.resolve(heard);
    }
    return answered.promise;
  });
  try {
    const { stripe } = fake;
    const customer = await ask(stripe, '/v1/customers', {
      fields: { email: 'twice@example.test' },
    });
    const session = await ask(stripe, '/v1/checkout/sessions', {
      fields: {
        mode: 'subscription',
        customer: String(customer.body['id']),
        'line_items[0][price]': 'monthly',
        success_url: 'https://app.test/?billing=success',
        cancel_url: 'https://app.test/?billing=cancelled',
      },
    });
    const page = String(session.body['url']);
    const payOnce = async (): Promise<number> => {
      const { status } = await fetch(page, { method: 'POST', redirect: 'manual' });
      answered.resolve(status);
      return status;
    };
    const statuses = await Promise.all([payOnce(), payOnce()]);
    assert.deepEqual(statuses.toSorted(), [303, 404]);
    assert.deepEqual(fake.events(), ['customer.subscription.created']);
  } finally {
    await fake.stop();
  }
});

await test('a renewal can fail, a lapse be set, the portal opened and the customer deleted', async () => {
  const fake = await stand();
  try {
    const { stripe } = fake;
    const subscription = await subscribed(fake);
    const due = await ask(stripe, `/fake/past-due/${subscription}`, { fields: {} });
    assert.equal(due.body['status'], 'past_due');
    const lapse = await ask(stripe, `/v1/subscriptions/${subscription}`, {
      fields: { cancel_at_period_end: 'true' },
    });
    assert.equal(lapse.body['cancel_at_period_end'], true);
    const portal = await ask(stripe, '/v1/billing_portal/sessions', {
      fields: { return_url: 'https://app.test/' },
    });
    const opened = await fetch(String(portal.body['url']));
    assert.match(await opened.text(), /Billing portal/u);
    const customer = String(
      field(fake.heard[0] === undefined ? {} : fake.heard[0].object, 'customer'),
    );
    const deleted = ask(stripe, `/fake/deleted/${customer}`);
    await ask(stripe, `/v1/customers/${customer}`, { method: 'DELETE' });
    const answered = await deleted;
    assert.equal(answered.body['deleted'], true);
    const gone = await ask(stripe, `/v1/customers/${customer}`, { method: 'DELETE' });
    assert.equal(gone.status, 404);
  } finally {
    await fake.stop();
  }
});
