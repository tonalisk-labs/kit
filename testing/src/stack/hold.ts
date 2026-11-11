// A hold (a stack lock, a CPU turn) is an open request: granted with the response head, and held
// until the holder closes it, so a holder that dies gives it back.
import { type ClientRequest, type IncomingMessage, request } from 'node:http';

import { isObject } from '../unknown.ts';

/** The header a hold's request names its holder in (its test, worker and process), URI-encoded
 *  for the characters a test's title holds and a header can't. */
export const HOLDER_HEADER = 'x-kit-holder';

/** A kind of hold: what it is called, what a refusal of it says, and who hears should the server
 *  end it first; with no one named, the holder's release fails instead. */
export interface HoldKind {
  readonly held: string;
  readonly refused: (status: number | undefined) => string;
  readonly ended?: () => void;
}

/** One holding a server lists: what, by whom, since when, held or waited for. */
const described = (entry: unknown, now: number): string => {
  if (!isObject(entry)) {
    return String(entry);
  }
  const { what, who, since, held } = entry;
  const seconds = typeof since === 'number' ? Math.round((now - since) / 1000) : '?';
  const state = held === true ? 'held' : 'waited for';
  return `${String(what)} ${state} by ${String(who)} for ${String(seconds)} s`;
};

/** Who holds and waits at `origin`, as its GET /holders lists them, or why it couldn't say. */
const holdersAt = async (origin: string): Promise<string> => {
  try {
    const answer = await fetch(new URL('/holders', origin), { signal: AbortSignal.timeout(5000) });
    const listed: unknown = await answer.json();
    if (!Array.isArray(listed) || listed.length === 0) {
      return 'it records no holder or waiter';
    }
    const now = Date.now();
    return listed.map((entry) => described(entry, now)).join('; ');
  } catch (error) {
    return `its holders could not be read: ${String(error)}`;
  }
};

/** A hold refused, with the status the server answered. */
const refusal = (message: string, status: number | undefined): Error =>
  Object.assign(new Error(message), { status });

/** The status a refusal carries, if any. */
export const statusOf = (error: unknown): unknown =>
  error instanceof Error && 'status' in error ? error.status : undefined;

/** A granted hold's release: one its server cut off first ran unheld, so the release says so, unless
 *  the kind names who hears it; one the server ended whole was let go by its run, which is stopping. */
const releaseOf = (
  call: ClientRequest,
  granted: IncomingMessage,
  { held, ended }: HoldKind,
): (() => void) => {
  const state = { released: false, cut: false };
  call.once('close', () => {
    const early = !state.released;
    state.cut = early && !granted.complete;
    if (early && ended !== undefined) {
      ended();
    }
  });
  return () => {
    state.released = true;
    call.destroy();
    if (state.cut && ended === undefined) {
      throw new Error(`${held} ended before its release, so the work it covered ran without it`);
    }
  };
};

/** Asks `url` for a hold, answering its release once granted; an abort ends one that is, and gives
 *  up one not yet granted with an AbortError naming who held what it waited for. */
export const openHold = async (
  url: URL,
  kind: HoldKind,
  { signal, who }: { readonly signal?: AbortSignal | undefined; readonly who?: string } = {},
): Promise<() => void> => {
  const { promise, resolve, reject } = Promise.withResolvers<() => void>();
  const headers = who === undefined ? {} : { [HOLDER_HEADER]: encodeURIComponent(who) };
  const waiting: { failing?: Promise<void> } = {};
  const call = request(url, { method: 'POST', signal, headers }, (response) => {
    const { statusCode: status } = response;
    // Read: a refusal to its end, so its socket is freed, as one left unread holds the process open;
    // a grant, so that its server ending it whole is heard.
    response.resume();
    if (status === 200) {
      resolve(releaseOf(call, response, kind));
    } else {
      reject(refusal(kind.refused(status), status));
    }
  });
  call.on('error', (error) => {
    if (signal === undefined || !signal.aborted) {
      reject(error);
      return;
    }
    waiting.failing = holdersAt(url.origin).then((holders) => {
      const given = `the wait for ${kind.held} was given up before a grant`;
      const named = new Error(`${given}: at its server, ${holders}`, { cause: error });
      reject(Object.assign(named, { name: 'AbortError' }));
    });
  });
  call.end();
  return promise;
};
