// The fake Stripe stood up for a test, with a webhook endpoint that keeps what it heard.
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';

import { type FakeStripe, startFakeStripe } from '../src/stack/stripe.ts';
import { isObject } from '../src/unknown.ts';

const PLANS = [{ id: 'monthly', interval: 'month', amounts: { usd: 450, eur: 400 } }] as const;

interface Heard {
  readonly type: string;
  readonly object: unknown;
}

export interface Stand {
  readonly stripe: FakeStripe;
  /** The webhook events received, in order. */
  readonly heard: Heard[];
  /** Their types alone. */
  readonly events: () => string[];
  readonly stop: () => Promise<void>;
}

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks = await Array.fromAsync(request, (chunk: Buffer) => chunk.toString('utf8'));
  return chunks.join('');
};

/** The fake with a webhook endpoint that keeps each event's type, and answers each once `answer`,
 *  given every event so far, resolves. */
export const stand = async (
  answer?: (heard: readonly Heard[]) => Promise<unknown>,
): Promise<Stand> => {
  const heard: Heard[] = [];
  const hook = createServer((request, response) => {
    bodyOf(request)
      .then(async (body) => {
        const event: unknown = JSON.parse(body);
        heard.push({ type: String(field(event, 'type')), object: field(event, 'data', 'object') });
        if (answer !== undefined) {
          await answer(heard);
        }
        response.writeHead(200).end();
      })
      .catch(() => {
        response.writeHead(500).end();
      });
  });
  hook.listen(0, '127.0.0.1');
  await once(hook, 'listening');
  const address = hook.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const stripe = await startFakeStripe({
    plans: PLANS,
    webhookUrl: `http://127.0.0.1:${String(port)}`,
  });
  const stop = async (): Promise<void> => {
    await stripe.stop();
    hook.close();
    await once(hook, 'close');
  };
  return { stripe, heard, events: () => heard.map(({ type }) => type), stop };
};

/** The value at `path`, through objects by key and arrays by index. */
export const field = (value: unknown, ...path: string[]): unknown => {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at)) {
      at = at[Number(key)];
    } else {
      at = isObject(at) ? at[key] : undefined;
    }
  }
  return at;
};

export interface Asking {
  readonly fields?: Record<string, string>;
  readonly method?: string;
  readonly key?: string;
}

export const ask = async (
  stripe: FakeStripe,
  route: string,
  { fields, method = fields === undefined ? 'GET' : 'POST', key }: Asking = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
  // A redirect is Stripe's answer, as a browser would follow it: the test reads it as it is.
  const init: RequestInit =
    method === 'GET'
      ? { redirect: 'manual' }
      : { method, redirect: 'manual', body: new URLSearchParams(fields) };
  if (key !== undefined) {
    init.headers = { 'idempotency-key': key };
  }
  const response = await fetch(`${stripe.url}${route}`, init);
  const body: unknown = await response.json();
  return { status: response.status, body: isObject(body) ? body : {} };
};
