import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FakeStripe } from '../src/stack/stripe.ts';
import { ask, field, stand } from './stripe-stand.ts';

const HOUR = 3600;

/** A one-time payment's form, as a booking site's backend sends it. */
const formOf = (life = HOUR): Record<string, string> => ({
  mode: 'payment',
  expires_at: String(Math.floor(Date.now() / 1000) + life),
  success_url: 'https://site.test/paid?session={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://site.test/',
  'line_items[0][price_data][unit_amount]': '5000',
  'line_items[0][price_data][currency]': 'eur',
  customer_email: 'guest@example.test',
  'payment_method_types[0]': 'card',
});

/** Opens a session from `fields`: a repeat under one key must send the very same form, so a
 *  test that repeats one makes the form once, whatever second the clock has reached. */
const open = async (
  stripe: FakeStripe,
  key?: string,
  fields: Record<string, string> = formOf(),
): Promise<string> => {
  const made = await ask(
    stripe,
    '/v1/checkout/sessions',
    key === undefined ? { fields } : { fields, key },
  );
  return String(made.body['id']);
};

await test('a payment needs a long enough life and a return that names the session', async () => {
  const { stripe, stop } = await stand();
  try {
    const short = await ask(stripe, '/v1/checkout/sessions', { fields: formOf(60) });
    assert.equal(field(short.body, 'error', 'code'), 'parameter_invalid');
    const form = formOf();
    const [first, again] = [await open(stripe, 'key-1', form), await open(stripe, 'key-1', form)];
    assert.equal(first, again, 'a repeated key answers the same session');
    const other = await ask(stripe, '/v1/checkout/sessions', {
      fields: formOf(2 * HOUR),
      key: 'key-1',
    });
    assert.equal(field(other.body, 'error', 'code'), 'idempotency_key_in_use');
    const read = await ask(stripe, `/v1/checkout/sessions/${first}?expand[]=payment_intent`);
    assert.equal(read.body['status'], 'open');
    assert.equal(read.body['amount_total'], 5000);
  } finally {
    await stop();
  }
});

/** A session paid at Checkout, by its id and its payment intent. */
const paidAt = async (stripe: FakeStripe): Promise<{ session: string; intent: string }> => {
  const session = await open(stripe);
  const paid = await fetch(`${stripe.url}/checkout/${session}`, {
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(paid.headers.get('location'), `https://site.test/paid?session=${session}`);
  const read = await ask(stripe, `/v1/checkout/sessions/${session}?expand[]=payment_intent`);
  assert.equal(field(read.body, 'payment_intent', 'latest_charge', 'amount'), 5000);
  return { session, intent: String(field(read.body, 'payment_intent', 'id')) };
};

await test('a payment made at Checkout is announced and refunded once', async () => {
  const { stripe, stop } = await stand();
  try {
    const page = await fetch(`${stripe.url}/checkout/${await open(stripe)}`);
    assert.match(await page.text(), /href="https:\/\/site\.test\/"/u, 'its way back');
    const { session, intent } = await paidAt(stripe);
    const delivered = await ask(stripe, `/fake/delivered/checkout.session.completed/${session}`);
    assert.deepEqual(delivered.body['statuses'], [200]);
    const refund = { fields: { payment_intent: intent }, key: 'refund-1' };
    const refunded = await ask(stripe, '/v1/refunds', refund);
    assert.equal(refunded.body['amount'], 5000);
    const replayed = await ask(stripe, '/v1/refunds', refund);
    assert.equal(replayed.body['id'], refunded.body['id']);
    const twice = await ask(stripe, `/fake/refund/${session}`, { fields: {} });
    assert.equal(field(twice.body, 'error', 'code'), 'charge_already_refunded');
  } finally {
    await stop();
  }
});

await test('a delivered event can be sent again, and one never sent cannot', async () => {
  const { stripe, stop } = await stand();
  try {
    const { session } = await paidAt(stripe);
    await ask(stripe, `/fake/delivered/checkout.session.completed/${session}`);
    const resent = await ask(stripe, `/fake/redeliver/checkout.session.completed/${session}`, {
      fields: {},
    });
    assert.equal(resent.body['status'], 200);
    const none = await ask(stripe, `/fake/redeliver/charge.dispute.created/${session}`, {
      fields: {},
    });
    assert.equal(none.status, 404);
  } finally {
    await stop();
  }
});

await test('a delayed payment settles either way, and only once', async () => {
  const { stripe, stop } = await stand();
  try {
    const [later, failing] = [await open(stripe), await open(stripe)];
    await ask(stripe, `/fake/pay-async/${later}`, { fields: {} });
    await ask(stripe, `/fake/pay-async/${failing}`, { fields: {} });
    const settled = await ask(stripe, `/fake/async/${later}/succeed`, { fields: {} });
    assert.equal(settled.body['payment_status'], 'paid');
    const again = await ask(stripe, `/fake/async/${later}/succeed`, { fields: {} });
    assert.equal(field(again.body, 'error', 'code'), 'payment_intent_unexpected_state');
    const failed = await ask(stripe, `/fake/async/${failing}/fail`, { fields: {} });
    assert.equal(failed.body['payment_status'], 'unpaid');
    const unknown = await ask(stripe, '/fake/async/cs_none/succeed', { fields: {} });
    assert.equal(unknown.status, 404);
  } finally {
    await stop();
  }
});

await test('an open payment expires, loudly or quietly, and a closed one cannot', async () => {
  const { stripe, stop } = await stand();
  try {
    const [loud, quiet] = [await open(stripe), await open(stripe)];
    const expired = await ask(stripe, `/v1/checkout/sessions/${loud}/expire`, { fields: {} });
    assert.equal(expired.body['status'], 'expired');
    await ask(stripe, `/fake/expire/${quiet}?silent=1`, { fields: {} });
    const closed = await ask(stripe, `/v1/checkout/sessions/${loud}/expire`, { fields: {} });
    assert.equal(field(closed.body, 'error', 'code'), 'checkout_session_not_open');
    const unpaid = await fetch(`${stripe.url}/checkout/${loud}`, { method: 'POST' });
    assert.equal(unpaid.status, 400, 'an expired session takes no payment');
    const answers = await Promise.all([
      ask(stripe, '/v1/checkout/sessions/cs_none'),
      ask(stripe, '/fake/expire/cs_none', { fields: {} }),
      ask(stripe, '/fake/refund/cs_none', { fields: {} }),
      ask(stripe, `/fake/refund/${quiet}`, { fields: {} }),
    ]);
    assert.deepEqual(
      answers.map(({ status }) => status),
      [404, 404, 404, 404],
    );
  } finally {
    await stop();
  }
});
