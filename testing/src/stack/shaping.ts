import { getDefaultHighWaterMark, Transform, type TransformCallback } from 'node:stream';

import type { NetworkProfile } from '../network.ts';

/** One direction of one context's link, its bandwidth shared by every connection and HTTP/2 stream.
 *  The profile may change while they are open; without one, bytes pass at once. */
export interface Link {
  profile: NetworkProfile | undefined;
  /** When the link finishes sending what it already accepted, on the performance clock. */
  free: number;
}

/** What a link takes of one answer before pushing back on its upstream: Chromium's HTTP/2 stream
 *  window, so an answer frees its pooled connection once sent, however slow the link. */
export const AHEAD_BYTES = 6 * 1024 * 1024;

/** Bytes put on the link at once, as an HTTP/2 DATA frame: streams take turns by the slice. */
const SLICE_BYTES = 16 * 1024;

const slices = (chunk: Buffer): Buffer[] =>
  Array.from({ length: Math.ceil(chunk.length / SLICE_BYTES) }, (_slice, index) =>
    chunk.subarray(index * SLICE_BYTES, (index + 1) * SLICE_BYTES),
  );

const transmitMs = (bytes: number, kbps: number): number => (bytes * 8) / kbps;

const profileOf = (link: Link | undefined): NetworkProfile | undefined =>
  link === undefined ? undefined : link.profile;

/** When `bytes` put on the link now arrive: after the link frees, their transmission, half a
 *  round trip, jitter, and `owedRtts` round trips more. */
const arrival = (link: Link | undefined, bytes: number, owedRtts: number): number => {
  const profile = profileOf(link);
  if (link === undefined || profile === undefined) {
    return performance.now();
  }
  link.free = Math.max(performance.now(), link.free) + transmitMs(bytes, profile.kbps);
  const flight = profile.rttMs / 2 + Math.random() * profile.jitter * profile.rttMs;
  return link.free + flight + owedRtts * profile.rttMs;
};

/** How long a message head of `bytes` sent now takes to arrive, queued behind what the link
 *  carries; `owedRtts` adds the round trips a new connection's handshakes cost. */
export const headDelayMs = (link: Link | undefined, bytes: number, owedRtts: number): number =>
  Math.max(0, arrival(link, bytes, owedRtts) - performance.now());

interface InFlight {
  readonly at: number;
  readonly slice: Buffer;
}

/** The slices on their way in one direction, in order of arrival. */
interface Line {
  readonly link: Link | undefined;
  readonly queue: InFlight[];
  readonly stream: Transform;
  timer?: NodeJS.Timeout | undefined;
  ready?: NodeJS.Timeout;
  flushed?: TransformCallback;
}

const due = ({ queue }: Line): InFlight | undefined => {
  const [head] = queue;
  return head !== undefined && head.at <= performance.now() ? head : undefined;
};

const pump = (line: Line): void => {
  line.timer = undefined;
  for (let head = due(line); head !== undefined; head = due(line)) {
    line.queue.shift();
    line.stream.push(head.slice);
  }
  const [next] = line.queue;
  if (next !== undefined) {
    line.timer = setTimeout(
      () => {
        pump(line);
      },
      Math.max(0, next.at - performance.now()),
    );
  } else if (line.flushed !== undefined) {
    line.flushed();
  }
};

/** Puts one slice on the link, and the next only once the link has sent it. */
const feed = (
  line: Line,
  [all, at]: readonly [readonly Buffer[], number],
  done: TransformCallback,
): void => {
  const slice = all[at];
  if (slice === undefined) {
    done();
    return;
  }
  const { link, queue } = line;
  const last = queue.at(-1);
  queue.push({
    at: Math.max(last === undefined ? 0 : last.at, arrival(link, slice.length, 0)),
    slice,
  });
  line.timer ??= setTimeout(() => {
    pump(line);
  }, 0);
  const free = link === undefined ? 0 : link.free;
  line.ready = setTimeout(
    () => {
      feed(line, [all, at + 1], done);
    },
    Math.max(0, free - performance.now()),
  );
};

/** Delays one direction as the link would: one slice per stream on it at a time, so streams take
 *  turns as HTTP/2 frames do; one timer at a time, so jitter never reorders bytes. */
export const shaper = (
  link: Link | undefined,
  aheadBytes = getDefaultHighWaterMark(false),
): Transform => {
  const stream: Transform = new Transform({
    writableHighWaterMark: aheadBytes,
    transform: (chunk: Buffer, _encoding, done) => {
      // Unshaped with nothing queued, bytes pass in the same turn, as a socket's own relay would.
      if (line.queue.length === 0 && profileOf(link) === undefined) {
        stream.push(chunk);
        done();
      } else {
        feed(line, [slices(chunk), 0], done);
      }
    },
    flush: (done) => {
      if (line.queue.length === 0) {
        done();
        return;
      }
      line.flushed = done;
    },
    destroy: (error, done) => {
      clearTimeout(line.timer);
      clearTimeout(line.ready);
      done(error);
    },
  });
  const line: Line = { link, queue: [], stream };
  return stream;
};
