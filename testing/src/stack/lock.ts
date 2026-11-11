import type { ServerResponse } from 'node:http';

import { holdingsNamed, holdOpen, semaphore } from './gate-server.ts';

/** Who holds a target's stack: many tests share it, one that disturbs it owns it alone. */
export type Hold = 'share' | 'own';

interface Waiting {
  readonly hold: Hold;
  readonly grant: () => void;
}

interface Stack {
  sharers: number;
  owned: boolean;
  /** Each hold's waiters, first come, first served. */
  readonly queued: Readonly<Record<Hold, Waiting[]>>;
}

/** Grants every waiting sharer while no owner holds the stack, and the first waiting owner once
 *  none share. One splice takes the sharers: a shift for each copies the array each time. */
const admit = (stack: Stack): void => {
  const { share, own } = stack.queued;
  if (stack.owned) {
    return;
  }
  for (const sharer of share.splice(0)) {
    stack.sharers += 1;
    sharer.grant();
  }
  const owner = stack.sharers === 0 ? own.shift() : undefined;
  if (owner !== undefined) {
    stack.owned = true;
    owner.grant();
  }
};

const take = async (stack: Stack, hold: Hold, gone: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const waiting: Waiting = {
    hold,
    grant: () => {
      resolve(true);
    },
  };
  const queue = stack.queued[hold];
  // A test that gave up waiting (its timeout) leaves the queue, so it never holds on.
  gone.addEventListener('abort', () => {
    const at = queue.indexOf(waiting);
    if (at !== -1) {
      queue.splice(at, 1);
      admit(stack);
    }
  });
  queue.push(waiting);
  admit(stack);
  await promise;
};

const give = (stack: Stack, hold: Hold): void => {
  if (hold === 'own') {
    stack.owned = false;
  } else {
    stack.sharers -= 1;
  }
  admit(stack);
};

/** A readers-writer lock per target, kept by the stack host. A waiting owner stops no sharer:
 *  owners queue after every shared test, so stopping sharers would only idle workers. */
export const stackLocks = (): {
  readonly take: (key: string, hold: Hold, gone: AbortSignal) => Promise<void>;
  readonly give: (key: string, hold: Hold) => void;
} => {
  const stacks = new Map<string, Stack>();
  const stackOf = (key: string): Stack => {
    const found = stacks.get(key) ?? { sharers: 0, owned: false, queued: { share: [], own: [] } };
    stacks.set(key, found);
    return found;
  };
  return {
    take: async (key, hold, gone) => take(stackOf(key), hold, gone),
    give: (key, hold) => {
      give(stackOf(key), hold);
    },
  };
};

/** How long a pool's seats may go without changing hands while a test waits for them: then the
 *  wait fails, naming who holds and who waits. Each holder is a test under its own timeout, so
 *  seats this still are leaked, not queued. */
export const SEAT_STALL_MS = 600_000;

/** The clock a stall is read on, and its alarm, which `after`'s answer cancels; a test's is its
 *  own. */
export interface Clock {
  readonly now: () => number;
  readonly after: (ms: number, ring: () => void) => () => void;
}

const MONOTONIC: Clock = {
  now: () => performance.now(),
  after: (ms, ring) => {
    const timer = setTimeout(ring, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Fails once the pool's seats have stood still for `stall` since the later of their last move
 *  and the wait's start, unless the wait ends first. */
const stalled = async (
  moved: { at: number },
  { stall, clock }: { readonly stall: number; readonly clock: Clock },
  ended: AbortSignal,
): Promise<never> => {
  const { promise, reject } = Promise.withResolvers<never>();
  const since = clock.now();
  const check = (): void => {
    const still = clock.now() - Math.max(moved.at, since);
    if (still < stall) {
      ended.addEventListener('abort', clock.after(stall - still, check), { once: true });
      return;
    }
    const seconds = String(Math.round(stall / 1000));
    reject(new Error(`no seat changed hands in ${seconds} s: ${holdingsNamed()}`));
  };
  ended.addEventListener('abort', clock.after(stall, check), { once: true });
  return promise;
};

/** A pool of `size` seats, a holder taking the ones it asks for all at once, in the order asked;
 *  more than the pool has is refused at once, as it could never be seated. A wait fails once the
 *  seats stand still for `stall`, by `clock`. */
export const seatPool = (
  size: number,
  { stall = SEAT_STALL_MS, clock = MONOTONIC }: { stall?: number; clock?: Clock } = {},
): ((outgoing: ServerResponse, asked: string, who: string) => void) => {
  const pool = semaphore(size);
  const moved = { at: clock.now() };
  const seated = async (count: number, gone: AbortSignal): Promise<void> => {
    const ended = new AbortController();
    try {
      await Promise.race([
        pool.take('seats', count, AbortSignal.any([gone, ended.signal])),
        stalled(moved, { stall, clock }, ended.signal),
      ]);
      moved.at = clock.now();
    } finally {
      ended.abort();
    }
  };
  return (outgoing, asked, who) => {
    const count = Number(asked);
    if (!Number.isInteger(count) || count < 1 || count > size) {
      outgoing.writeHead(400).end(`the pool seats 1 to ${String(size)} at once, not ${asked}`);
      return;
    }
    holdOpen(outgoing, {
      take: async (gone) => seated(count, gone),
      give: () => {
        moved.at = clock.now();
        pool.give(count);
      },
      what: `${String(count)} of the Linux browsers' ${String(size)} seats`,
      who,
    });
  };
};
