import type { ServerResponse } from 'node:http';

import { holdingsNamed, holdOpen, semaphore } from './gate-server.ts';
import { STILLNESS, type Stillness, type Watch, watchOf } from './stall.ts';

/** Who asks for a hold, by when their test must end, and the id its request gave. */
export interface Holder {
  readonly who: string;
  readonly deadline: number | undefined;
  readonly id: string | undefined;
}

/** Who holds a target's stack: many tests share it, one that disturbs it owns it alone. */
export type Hold = 'share' | 'own';

interface Waiting {
  readonly hold: Hold;
  readonly grant: () => void;
}

interface Stack {
  sharers: number;
  owned: boolean;
  readonly watch: Watch;
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
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const queue = stack.queued[hold];
  // A test that gave up waiting (its timeout), or whose wait stalled, leaves the queue, so it
  // never holds on.
  const leave = (): void => {
    const at = queue.indexOf(waiting);
    if (at !== -1) {
      queue.splice(at, 1);
      admit(stack);
    }
  };
  const done = stack.watch.waiting((stalled) => {
    leave();
    reject(stalled);
  });
  const waiting: Waiting = {
    hold,
    grant: () => {
      done();
      stack.watch.moved();
      resolve(true);
    },
  };
  gone.addEventListener('abort', () => {
    done();
    leave();
  });
  queue.push(waiting);
  admit(stack);
  await promise;
};

const give = (stack: Stack, hold: Hold): void => {
  stack.watch.moved();
  if (hold === 'own') {
    stack.owned = false;
  } else {
    stack.sharers -= 1;
  }
  admit(stack);
};

/** A readers-writer lock per target; a waiting owner stops no sharer, which would only idle
 *  workers, and a wait fails once no hold on its stack changes hands for the stillness's stall. */
export const stackLocks = (
  stillness: Stillness = STILLNESS,
): {
  readonly take: (key: string, hold: Hold, gone: AbortSignal) => Promise<void>;
  readonly give: (key: string, hold: Hold) => void;
  /** The watch over a stack's waits, which a server counts each holder in. */
  readonly watch: (key: string) => Watch;
} => {
  const stacks = new Map<string, Stack>();
  const stackOf = (key: string): Stack => {
    const found = stacks.get(key) ?? {
      sharers: 0,
      owned: false,
      watch: watchOf(stillness, { what: `no hold on ${key}`, named: holdingsNamed }),
      queued: { share: [], own: [] },
    };
    stacks.set(key, found);
    return found;
  };
  return {
    take: async (key, hold, gone) => take(stackOf(key), hold, gone),
    give: (key, hold) => {
      give(stackOf(key), hold);
    },
    watch: (key) => stackOf(key).watch,
  };
};

/** A pool of `size` seats, each holder seated all at once in the order asked, more than the pool
 *  refused; a wait fails once no seat has changed hands for the stillness's stall. */
export const seatPool = (
  size: number,
  stillness: Stillness = STILLNESS,
): ((outgoing: ServerResponse, asked: string, holder: Holder) => void) => {
  const pool = semaphore(size, { stillness, what: 'no seat' });
  return (outgoing, asked, { who, deadline, id }) => {
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
      deadline,
      watch: pool.watch,
      id,
    });
  };
};
