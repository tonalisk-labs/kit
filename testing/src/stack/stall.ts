// The bound on every hold's wait: a CPU turn, a stack lock, a seat. Waits fail once nothing they
// wait among has changed hands for a while, naming who holds what; a queue that moves, however
// long, never trips it. Each holder is a test under its own timeout, so a stillness this long is
// a leak, not a queue.

/** How long a hold's wait may see nothing change hands. */
const STALL_MS = 600_000;

/** The clock a stall is read on, and its alarm, which `after`'s answer cancels; a test's is its
 *  own. */
export interface Clock {
  readonly now: () => number;
  readonly after: (ms: number, ring: () => void) => () => void;
}

const MONOTONIC: Clock = {
  now: () => performance.now(),
  after: (ms, ring) => {
    // An alarm never holds its process open: a wait still pending keeps it open itself.
    const timer = setTimeout(ring, ms).unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

/** How waits are bounded: the stillness they fail after, on its clock. */
export interface Stillness {
  readonly stall: number;
  readonly clock: Clock;
}

export const STILLNESS: Stillness = { stall: STALL_MS, clock: MONOTONIC };

/** What a stalled wait says: what stood still, and who held and waited for it. */
export interface Still {
  readonly what: string;
  readonly named: () => string;
}

/** One resource's watch over its waits: its moves, and its waits, bounded by them. */
export interface Watch {
  /** A grant or a give: the resource changed hands. */
  readonly moved: () => void;
  /** Counts a wait from now, which `fail` ends should the resource stand still; the answer is
   *  called once the wait ends, granted or not. */
  readonly waiting: (fail: (error: Error) => void) => () => void;
}

interface Alarm {
  at: number;
  cancel: (() => void) | undefined;
  readonly failing: Set<(error: Error) => void>;
}

/** Rings the stall: re-armed for the rest while the resource moved within it, else every pending
 *  wait fails, as all wait on the same stillness. */
const ringOf =
  ({ stall, clock }: Stillness, still: Still, alarm: Alarm) =>
  (): void => {
    alarm.cancel = undefined;
    if (alarm.failing.size === 0) {
      return;
    }
    const quiet = clock.now() - alarm.at;
    if (quiet < stall) {
      alarm.cancel = clock.after(stall - quiet, ringOf({ stall, clock }, still, alarm));
      return;
    }
    const seconds = String(Math.round(stall / 1000));
    const error = new Error(`${still.what} changed hands in ${seconds} s: ${still.named()}`);
    for (const fail of alarm.failing) {
      fail(error);
    }
  };

/** A resource's watch: one alarm while any wait is pending, measuring from the later of its last
 *  move and when its waits began. A wait costs a set entry, so thousands queue as cheaply as one. */
export const watchOf = (stillness: Stillness, still: Still): Watch => {
  const { stall, clock } = stillness;
  const alarm: Alarm = { at: clock.now(), cancel: undefined, failing: new Set() };
  const ring = ringOf(stillness, still, alarm);
  return {
    moved: () => {
      alarm.at = clock.now();
    },
    waiting: (fail) => {
      if (alarm.failing.size === 0) {
        alarm.at = clock.now();
      }
      alarm.failing.add(fail);
      alarm.cancel ??= clock.after(stall, ring);
      return () => {
        alarm.failing.delete(fail);
        if (alarm.failing.size === 0 && alarm.cancel !== undefined) {
          alarm.cancel();
          alarm.cancel = undefined;
        }
      };
    },
  };
};
