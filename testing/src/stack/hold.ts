// A hold (a stack lock, a CPU turn) is an open request: granted with the response head, and held
// until the holder closes it, so a holder that dies gives it back.
import { type ClientRequest, type IncomingMessage, request } from 'node:http';

/** A kind of hold: what it is called, what a refusal of it says, and who hears should the server
 *  end it first; with no one named, the holder's release fails instead. */
export interface HoldKind {
  readonly held: string;
  readonly refused: (status: number | undefined) => string;
  readonly ended?: () => void;
}

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

/** Asks `url` for a hold, answering its release once granted; an abort gives up a hold not yet
 *  granted, and ends one that is. */
export const openHold = async (
  url: URL,
  kind: HoldKind,
  signal?: AbortSignal,
): Promise<() => void> => {
  const { promise, resolve, reject } = Promise.withResolvers<() => void>();
  const call = request(url, { method: 'POST', signal }, (response) => {
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
  call.on('error', reject);
  call.end();
  return promise;
};
