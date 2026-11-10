import type { Socket } from 'node:net';

import { CONTEXT_COOKIE, profileOf } from '../network.ts';
import type { Link } from './shaping.ts';

/** One browser context, or one headless client, as the edge knows it by its cookie. */
export interface EdgeContext {
  /** The client address the backend is told, so per-IP limits apply per context. */
  readonly ip: string;
  /** Both directions, shared by all its connections and streams. The profile can change. */
  readonly up: Link;
  readonly down: Link;
  /** Its upgraded connections (WebSockets), client and upstream sides. */
  readonly live: Set<Socket>;
  /** How long the edge holds its requests for a pathname before passing them on, in ms, as a
   *  slow origin answers them; none by default. */
  readonly delays: Map<string, number>;
  /** Answers the edge gives in the origin's place, each to the next request it matches, in the
   *  order they were asked for. */
  readonly faults: Fault[];
}

/** How the edge answers in the origin's place: a refusal (`status`), a body cut off by a reset
 *  (`reset`), silence until the client gives up (`hang`), or a captive portal's page (`page`). */
export type FaultKind = 'status' | 'reset' | 'hang' | 'page';

/** The kinds a harness names in a status's place. */
const KINDS: ReadonlySet<string> = new Set<FaultKind>(['reset', 'hang', 'page']);

const isKind = (value: string): value is Exclude<FaultKind, 'status'> => KINDS.has(value);

/** One answer the edge gives in the origin's place, to the next `method` request whose path
 *  matches `segments`, as `kind` says: a refusal has `status`, and `Retry-After` when above 0. */
export interface Fault {
  readonly method: string;
  readonly segments: readonly string[];
  readonly kind: FaultKind;
  readonly status: number;
  readonly retryAfter: number;
}

export type Contexts = Map<string, EdgeContext>;

/** Addresses from 198.18.0.0/15 (RFC 2544), reserved for benchmarking: never a real client. */
const addressOf = (index: number): string =>
  `198.${String(18 + Math.floor(index / 65_024))}.${String(Math.floor(index / 254) % 256)}.${String((index % 254) + 1)}`;

/** The context a cookie header names, made on first sight; undefined without the cookie. */
export const contextOf = (contexts: Contexts, cookieHeader: string): EdgeContext | undefined => {
  const pair = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CONTEXT_COOKIE}=`));
  if (pair === undefined) {
    return undefined;
  }
  const value = pair.slice(CONTEXT_COOKIE.length + 1);
  const [network = '', id = value] = value.split('.');
  return ensured(contexts, id, network);
};

/** Made on first sight, with the network it was first seen on. */
const ensured = (contexts: Contexts, id: string, network: string): EdgeContext => {
  const known = contexts.get(id);
  if (known !== undefined) {
    return known;
  }
  const profile = profileOf(network);
  const made: EdgeContext = {
    ip: addressOf(contexts.size),
    up: { profile, free: 0 },
    down: { profile, free: 0 },
    live: new Set(),
    delays: new Map(),
    faults: [],
  };
  contexts.set(id, made);
  return made;
};

/** Where the harness steers a context: `…/<id>/` then `<action>[/<network>]`, `faults/clear`,
 *  `delay/<ms>/<pathname>` or `fault/<method>/<status>/<retry-after>/<pathname>`. */
export const CONTROL_PREFIX = '/.sites-testing/contexts/';

/** Holds a known context's requests for `pathname` `ms` before they go on; 0 ends the delay. */
const delay = (context: EdgeContext | undefined, ms: number, pathname: string): number => {
  if (context === undefined || !Number.isSafeInteger(ms) || ms < 0) {
    return 400;
  }
  if (ms === 0) {
    context.delays.delete(pathname);
  } else {
    context.delays.set(pathname, ms);
  }
  return 204;
};

/** A fault from the parts the harness wrote: a status in 400-599, or a kind in its place (`reset`,
 *  `hang`, `page`); undefined for anything else. */
export const faultOf = ({
  method,
  status,
  retryAfter,
  segments,
}: {
  readonly method: string;
  readonly status: string;
  readonly retryAfter: string;
  readonly segments: readonly string[];
}): Fault | undefined => {
  if (!/^[A-Z]+$/u.test(method)) {
    return undefined;
  }
  if (isKind(status)) {
    return { method, segments, kind: status, status: status === 'page' ? 200 : 0, retryAfter: 0 };
  }
  const [answer, wait] = [Number(status), Number(retryAfter)];
  const known = Number.isSafeInteger(answer) && answer >= 400 && answer <= 599;
  if (!known || !Number.isSafeInteger(wait) || wait < 0) {
    return undefined;
  }
  return { method, segments, kind: 'status', status: answer, retryAfter: wait };
};

const fault = (context: EdgeContext | undefined, rule: readonly string[]): number => {
  const [method = '', status = '', retryAfter = '', ...segments] = rule;
  const made = faultOf({ method, status, retryAfter, segments });
  if (context === undefined || made === undefined) {
    return 400;
  }
  context.faults.push(made);
  return 204;
};

/** A segment as a fault names it, a `*` in it matching any run of characters: `*` any one
 *  segment, `app.*.js` a chunk whatever its hash. */
const segmentMatches = (pattern: string, segment: string): boolean => {
  if (!pattern.includes('*')) {
    return pattern === segment;
  }
  const parts = pattern
    .split('*')
    .map((part) => part.replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`));
  return new RegExp(`^${parts.join('.*')}$`, 'u').test(segment);
};

const matches = (segments: readonly string[], path: readonly string[]): boolean =>
  segments.length === path.length &&
  segments.every((segment, at) => segmentMatches(segment, path[at] ?? ''));

/** The answer owed a request in the origin's place, taken from its queue: a context's, or any
 *  other link's that holds one. */
export const faultFor = (
  context: { readonly faults: Fault[] } | undefined,
  method: string,
  url: string,
): Fault | undefined => {
  if (context === undefined) {
    return undefined;
  }
  const [pathname = url] = url.split('?');
  const path = pathname.split('/').slice(1);
  const at = context.faults.findIndex(
    (rule) => rule.method === method && matches(rule.segments, path),
  );
  return at === -1 ? undefined : context.faults.splice(at, 1)[0];
};

/** The answer a fault gives: a problem the client reads as the origin's own, and the pause it
 *  asks for. */
export const faultAnswer = ({
  status,
  retryAfter,
}: Fault): { status: number; headers: Record<string, string>; body: string } => {
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (retryAfter > 0) {
    headers['retry-after'] = String(retryAfter);
  }
  const body = JSON.stringify({ type: 'about:blank', title: 'Injected by the test', status });
  return { status, headers, body };
};

export const heldMs = (context: EdgeContext | undefined, url: string): number => {
  const [pathname = url] = url.split('?');
  return context === undefined ? 0 : (context.delays.get(pathname) ?? 0);
};

/** Answers the status to reply with. */
const steerFaults = (
  context: EdgeContext | undefined,
  action: string,
  rest: readonly string[],
): number => {
  if (action === 'fault') {
    return fault(context, rest);
  }
  if (action === 'faults' && rest.join('/') === 'clear') {
    if (context !== undefined) {
      context.faults.splice(0);
    }
    return 204;
  }
  return 400;
};

/** Holds both ways of a context to `profile`, none for a wired network. */
const throttled = (context: EdgeContext, profile: EdgeContext['up']['profile']): number => {
  context.up.profile = profile;
  context.down.profile = profile;
  return 204;
};

/** Cuts every connection a context has open. */
const dropped = (context: EdgeContext | undefined): number => {
  for (const socket of context === undefined ? [] : context.live) {
    socket.destroy();
  }
  return 204;
};

/** One control request (CONTROL_PREFIX), answering the status to reply with. */
export const steer = (contexts: Contexts, path: string): number => {
  const [id = '', action = '', network = '', ...pathname] = path
    .slice(CONTROL_PREFIX.length)
    .split('/');
  if (action === 'network' && (network === 'wired' || profileOf(network) !== undefined)) {
    return throttled(ensured(contexts, id, network), profileOf(network));
  }
  if (action === 'drop') {
    return dropped(contexts.get(id));
  }
  if (action === 'delay') {
    return delay(contexts.get(id), Number(network), `/${pathname.join('/')}`);
  }
  return steerFaults(contexts.get(id), action, [network, ...pathname]);
};
