// The bound on every hold's wait: a CPU turn, a stack lock, a seat. Waits fail once nothing they
// wait among has changed hands for a while and every holder is past its test's deadline, naming
// who holds what and by when: a queue that moves, or a long test inside its own timeout, never
// trips it, and a holder that outlives its test is a leak.

/** How long a hold's wait may see nothing change hands; and for a holder that names no deadline,
 *  as a hold outside a test, how long it may keep it still. */
const STALL_MS = 600_000;

/** The clock a stall is read on, and its alarm, which `after`'s answer cancels; a test's is its
 *  own. */
export interface Clock {
  readonly now: () => number;
  readonly after: (ms: number, ring: () => void) => () => void;
}

/** Wall-clock time, as a holder's deadline is: its test's start, plus its timeout. */
const WALL: Clock = {
  now: () => Date.now(),
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

export const STILLNESS: Stillness = { stall: STALL_MS, clock: WALL };

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
  /** Counts a holder, by its test's deadline, until it lets go; its test may move the deadline. */
  readonly holding: (deadline: number | undefined) => Held;
}

/** A holder the watch counts: its deadline moved, or let go. */
export interface Held {
  readonly renew: (deadline: number | undefined) => void;
  readonly release: () => void;
}

interface Alarm {
  at: number;
  cancel: (() => void) | undefined;
  readonly failing: Set<(error: Error) => void>;
  readonly holders: Set<{ deadline: number | undefined }>;
}

/** When the resource's waits may fail: once still for the stall, and past every holder's deadline,
 *  a holder that names none keeping it still for the stall alone. */
const dueOf = ({ stall }: Stillness, alarm: Alarm): number =>
  Math.max(
    alarm.at + stall,
    ...[...alarm.holders].map(({ deadline }) => deadline ?? alarm.at + stall),
  );

/** Rings the stall: re-armed for the rest while the resource moved, or a holder is inside its
 *  deadline, else every pending wait fails, as all wait on the same stillness. */
const ringOf = (stillness: Stillness, still: Still, alarm: Alarm) => (): void => {
  const { stall, clock } = stillness;
  alarm.cancel = undefined;
  if (alarm.failing.size === 0) {
    return;
  }
  const left = dueOf(stillness, alarm) - clock.now();
  if (left > 0) {
    alarm.cancel = clock.after(left, ringOf(stillness, still, alarm));
    return;
  }
  const seconds = String(Math.round(stall / 1000));
  const past = `${still.what} changed hands in ${seconds} s, every holder past its deadline`;
  const error = new Error(`${past}: ${still.named()}`);
  for (const fail of alarm.failing) {
    fail(error);
  }
};

/** A resource's watch: one alarm while any wait is pending, measuring from the later of its last
 *  move and when its waits began. A wait costs a set entry, so thousands queue as cheaply as one. */
export const watchOf = (stillness: Stillness, still: Still): Watch => {
  const { stall, clock } = stillness;
  const alarm: Alarm = {
    at: clock.now(),
    cancel: undefined,
    failing: new Set(),
    holders: new Set(),
  };
  const ring = ringOf(stillness, still, alarm);
  return {
    moved: () => {
      alarm.at = clock.now();
    },
    holding: (deadline) => {
      const holder = { deadline };
      alarm.holders.add(holder);
      return {
        renew: (moved) => {
          holder.deadline = moved;
          // An earlier deadline brings the stall's check forward; a later one the check re-arms for.
          if (alarm.cancel !== undefined) {
            alarm.cancel();
            alarm.cancel = undefined;
            ring();
          }
        },
        release: () => {
          alarm.holders.delete(holder);
        },
      };
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
