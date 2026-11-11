import type { ServerResponse } from 'node:http';

import { holdOpen, semaphore } from './gate-server.ts';

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

/** A pool of `size` seats, a holder taking the ones it asks for all at once, in the order asked;
 *  more than the pool has is refused at once, as it could never be seated. */
export const seatPool = (
  size: number,
): ((outgoing: ServerResponse, asked: string, who: string) => void) => {
  const pool = semaphore(size);
  return (outgoing, asked, who) => {
    const count = Number(asked);
    if (!Number.isInteger(count) || count < 1 || count > size) {
      outgoing.writeHead(400).end(`the pool seats 1 to ${String(size)} at once, not ${asked}`);
      return;
    }
    holdOpen(outgoing, {
      take: async (gone) => pool.take('seats', count, gone),
      give: () => {
        pool.give(count);
      },
      what: `${String(count)} of the Linux browsers' ${String(size)} seats`,
      who,
    });
  };
};
