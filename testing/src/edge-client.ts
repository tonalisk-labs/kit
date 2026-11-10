import { randomUUID } from 'node:crypto';

import type { BrowserContext } from '@playwright/test';

import { CONTEXT_COOKIE } from './network.ts';
import { CONTROL_PREFIX } from './stack/contexts.ts';

const known = new WeakMap<BrowserContext, string>();

/** A client the edge will know as one context: its own address, network and live sockets. */
export interface EdgeIdentity {
  readonly id: string;
  /** The `Cookie` header a headless client sends on every request and upgrade. */
  readonly cookie: string;
}

/** A new identity on `network` for a client outside a browser, which sends its `cookie`. */
export const edgeIdentity = (network: string): EdgeIdentity => {
  const id = randomUUID();
  return { id, cookie: `${CONTEXT_COOKIE}=${network}.${id}` };
};

/** Names a browser context to the edge on `network`; the cookie never reaches the app. */
export const joinEdge = async (
  context: BrowserContext,
  origin: string,
  network: string,
): Promise<string> => {
  const { id } = edgeIdentity(network);
  await context.addCookies([
    { name: CONTEXT_COOKIE, value: `${network}.${id}`, url: origin, httpOnly: true },
  ]);
  known.set(context, id);
  return id;
};

/** The id `joinEdge` gave a browser context. */
export const edgeIdOf = (context: BrowserContext): string => {
  const id = known.get(context);
  if (id === undefined) {
    throw new Error('this browser context never joined the edge');
  }
  return id;
};

const steer = async (origin: string, id: string, action: string): Promise<void> => {
  const response = await fetch(new URL(`${CONTROL_PREFIX}${id}/${action}`, origin), {
    method: 'POST',
  });
  if (response.status !== 204) {
    throw new Error(`the edge answered ${String(response.status)} to ${action} for ${id}`);
  }
};

/** Moves a context's every connection, open or new, onto another network profile. */
export const setNetwork = async (origin: string, id: string, network: string): Promise<void> =>
  steer(origin, id, `network/${network}`);

/** Holds a context's requests for `pathname` `ms` at the edge, as a slow origin would; 0 ends it.
 *  The edge must know the context: it has set a network or sent a request. */
export const delayPath = async (
  origin: string,
  id: string,
  { pathname, ms }: { readonly pathname: string; readonly ms: number },
): Promise<void> => steer(origin, id, `delay/${String(ms)}${pathname}`);

/** The edge's answer in the origin's place to the next `method` request on `pathname` (a `*` spans
 *  part of a segment): `status`, with `Retry-After` past 0 s; or a reset body, a hang or a page. */
export type EdgeFault =
  | {
      readonly method: string;
      readonly pathname: string;
      readonly status: number;
      readonly retryAfter?: number;
    }
  | {
      readonly method: string;
      readonly pathname: string;
      readonly kind: 'reset' | 'hang' | 'page';
    };

/** A fault as the edge's control path names it: its method, then its status or kind, then its
 *  `Retry-After`. */
const ruleOf = (fault: EdgeFault): string =>
  'kind' in fault
    ? `${fault.method}/${fault.kind}/0`
    : `${fault.method}/${String(fault.status)}/${String(fault.retryAfter ?? 0)}`;

/** Queues answers for the context's next matching requests, one each; the edge must know it. */
export const failNext = async (
  origin: string,
  id: string,
  faults: readonly EdgeFault[],
): Promise<void> => {
  const [first, ...rest] = faults;
  if (first === undefined) {
    return;
  }
  await steer(origin, id, `fault/${ruleOf(first)}${first.pathname}`);
  // One after another: the edge answers them in the order they are queued.
  await failNext(origin, id, rest);
};

/** Forgets the answers queued for a context that no request has taken yet. */
export const clearFaults = async (origin: string, id: string): Promise<void> =>
  steer(origin, id, 'faults/clear');

/** Drops a context's live sockets, as a network losing them would. */
export const dropLive = async (origin: string, id: string): Promise<void> =>
  steer(origin, id, 'drop');
