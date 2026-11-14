// A hold (a stack lock, a CPU turn) is an open request: granted with the response head, and held
// until the holder closes it, so a holder that dies gives it back.
import { randomUUID } from 'node:crypto';
import { type ClientRequest, get, type IncomingMessage, request } from 'node:http';

import { isObject } from '../unknown.ts';

/** The header a hold's request names its holder in (its test, worker and process), URI-encoded
 *  for the characters a test's title holds and a header can't. */
export const HOLDER_HEADER = 'x-kit-holder';

/** The header a hold's request gives its test's deadline in, as epoch milliseconds. */
export const DEADLINE_HEADER = 'x-kit-deadline';

/** The header a hold's request gives its id in, by which its test moves its deadline later. */
export const HOLD_ID_HEADER = 'x-kit-hold';

/** A kind of hold: what it is called, what a refusal of it says, and who hears should the server
 *  end it first; with no one named, the holder's release fails instead. */
export interface HoldKind {
  readonly held: string;
  readonly refused: (status: number | undefined) => string;
  readonly ended?: () => void;
}

/** One holding a server lists: what, by whom, since when, held or waited for. */
export const described = (entry: unknown, now: number): string => {
  if (!isObject(entry)) {
    return String(entry);
  }
  const { what, who, since, held, deadline } = entry;
  const seconds = typeof since === 'number' ? Math.round((now - since) / 1000) : '?';
  const state = held === true ? 'held' : 'waited for';
  const left = typeof deadline === 'number' ? Math.round((deadline - now) / 1000) : undefined;
  const due =
    left === undefined
      ? ''
      : `, ${left >= 0 ? `due in ${String(left)} s` : `${String(-left)} s past its deadline`}`;
  return `${String(what)} ${state} by ${String(who)} for ${String(seconds)} s${due}`;
};

/** The holdings a GET /holders listed, each named. */
const namedIn = (listed: unknown): string => {
  if (!Array.isArray(listed) || listed.length === 0) {
    return 'it records no holder or waiter';
  }
  const now = Date.now();
  return listed.map((entry) => described(entry, now)).join('; ');
};

/** Who holds and waits at `origin`, or why it couldn't say, read with node:http: on macOS, Node
 *  24.21's fetch (undici 7.29.1) throws a reset uncaught from `setTypeOfService`. */
const holdersAt = async (origin: string): Promise<string> => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const failed = (error: unknown): void => {
    resolve(`its holders could not be read: ${String(error)}`);
  };
  const call = get(new URL('/holders', origin), { signal: AbortSignal.timeout(5000) }, (answer) => {
    const chunks: Buffer[] = [];
    answer
      .on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      })
      .once('end', () => {
        try {
          const listed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(namedIn(listed));
        } catch (error) {
          failed(error);
        }
      })
      .once('error', failed);
  });
  call.once('error', failed);
  return promise;
};

/** The holds this process has open, granted or waiting, by id: where each is served. */
const live = new Map<string, string>();

/** Moves the deadline of every hold this process has open to `deadline` (epoch milliseconds, or
 *  none), as its test's timeout moved; a server that can't be told keeps the one it had. */
export const announceDeadline = async (deadline?: number): Promise<void> => {
  const given = deadline === undefined ? 'none' : String(Math.ceil(deadline));
  await Promise.all(
    [...live].map(async ([id, origin]) => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const call = request(
        new URL(`/deadline/${id}/${given}`, origin),
        { method: 'POST' },
        (answer) => {
          answer.resume().once('end', () => {
            resolve(true);
          });
        },
      );
      call.once('error', () => {
        resolve(false);
      });
      call.end();
      await promise;
    }),
  );
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

/** How a hold is asked for: the signal that gives it up, who asks, by when their test must end,
 *  and the id its test moves that deadline by (one of its own, unless a relay passes it on). */
interface Asking {
  readonly signal?: AbortSignal | undefined;
  readonly who?: string;
  readonly deadline?: number | undefined;
  readonly id?: string | undefined;
}

/** A hold request's headers: its id, its holder's name, URI-encoded, and its test's deadline. */
const headersOf = ({ who, deadline }: Asking, id: string): Record<string, string> => {
  const headers: Record<string, string> = { [HOLD_ID_HEADER]: id };
  if (who !== undefined) {
    headers[HOLDER_HEADER] = encodeURIComponent(who);
  }
  if (deadline !== undefined) {
    headers[DEADLINE_HEADER] = String(Math.ceil(deadline));
  }
  return headers;
};

/** Counts a hold among this process's open ones, waiting or granted, until its request closes: its
 *  test may move its deadline meanwhile. */
const counted = (call: ClientRequest, id: string, origin: string): void => {
  live.set(id, origin);
  call.once('close', () => {
    live.delete(id);
  });
};

/** Asks `url` for a hold, answering its release once granted; an abort ends one that is, and gives
 *  up one not yet granted with an AbortError naming who held what it waited for. */
export const openHold = async (
  url: URL,
  kind: HoldKind,
  asking: Asking = {},
): Promise<() => void> => {
  const { signal, id = randomUUID() } = asking;
  const { promise, resolve, reject } = Promise.withResolvers<() => void>();
  const headers = headersOf(asking, id);
  const waiting: { granted: boolean; failing?: Promise<void> } = { granted: false };
  const call = request(url, { method: 'POST', signal, headers }, (response) => {
    const { statusCode: status } = response;
    // Read: a grant, so that its server ending it whole is heard; a refusal to its end, so its
    // socket is freed, as one left unread holds the process open, and what it says is told.
    if (status === 200) {
      waiting.granted = true;
      response.resume();
      resolve(releaseOf(call, response, kind));
      return;
    }
    const said: Buffer[] = [];
    response
      .on('data', (chunk: Buffer) => {
        said.push(chunk);
      })
      .once('close', () => {
        const reason = Buffer.concat(said).toString('utf8').trim();
        const message = kind.refused(status);
        reject(refusal(reason === '' ? message : `${message}: ${reason}`, status));
      });
  });
  call.on('error', (error) => {
    // A granted hold's end, by its release or its server, is the release's to hear.
    if (waiting.granted) {
      return;
    }
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
  counted(call, id, url.origin);
  call.end();
  return promise;
};
