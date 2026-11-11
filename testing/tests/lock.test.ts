import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { HOST_ENV, holdBrowserSeat } from '../src/stack/control.ts';
import { answerHolders, holderOf, semaphore } from '../src/stack/gate-server.ts';
import { openHold } from '../src/stack/hold.ts';
import { seatPool, stackLocks } from '../src/stack/lock.ts';
import { type Clock, STILLNESS, type Stillness } from '../src/stack/stall.ts';

const flush = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

await test('sharers pass a waiting owner, which runs alone once they are gone', async () => {
  const locks = stackLocks();
  const log: string[] = [];
  const ask = (name: string, hold: 'share' | 'own'): void => {
    locks.take('t', hold, new AbortController().signal).then(
      () => log.push(name),
      () => log.push(`${name} refused`),
    );
  };
  const then = async (action: () => void, expected: readonly string[]): Promise<void> => {
    action();
    await flush();
    assert.deepEqual(log, expected);
  };
  await then(() => {
    ask('s1', 'share');
    ask('o1', 'own');
    ask('s2', 'share');
    ask('o2', 'own');
  }, ['s1', 's2']);
  await then(() => {
    locks.give('t', 'share');
  }, ['s1', 's2']);
  await then(() => {
    locks.give('t', 'share');
  }, ['s1', 's2', 'o1']);
  await then(() => {
    ask('s3', 'share');
  }, ['s1', 's2', 'o1']);
  await then(() => {
    locks.give('t', 'own');
  }, ['s1', 's2', 'o1', 's3']);
  await then(() => {
    locks.give('t', 'share');
  }, ['s1', 's2', 'o1', 's3', 'o2']);
});

await test('a waiter that gives up leaves the queue, and the next owner goes in its place', async () => {
  const locks = stackLocks();
  const log: string[] = [];
  await locks.take('t', 'own', new AbortController().signal);
  const gone = new AbortController();
  locks.take('t', 'own', gone.signal).then(
    () => log.push('gone'),
    () => log.push('gone refused'),
  );
  locks.take('t', 'own', new AbortController().signal).then(
    () => log.push('kept'),
    () => log.push('kept refused'),
  );
  gone.abort();
  locks.give('t', 'own');
  await flush();
  assert.deepEqual(log, ['kept']);
});

await test('many waiting sharers are all let in at once, by the one give', async () => {
  const locks = stackLocks();
  await locks.take('t', 'own', new AbortController().signal);
  const count = 50_000;
  let admitted = 0;
  const turns = Array.from({ length: count }, async () => {
    await locks.take('t', 'share', new AbortController().signal);
    admitted += 1;
  });
  await flush();
  assert.equal(admitted, 0);
  locks.give('t', 'own');
  // One turn of the event loop and no other give: every sharer got in by that handoff.
  await flush();
  assert.equal(admitted, count);
  await Promise.all(turns);
});

/** A pool of `size` seats served as the stack host serves its browsers' seats, for `work`; its
 *  stall bound and clock, where given. */
const withPool = async (
  size: number,
  work: () => Promise<void>,
  stillness: Stillness = STILLNESS,
): Promise<void> => {
  const pooled = seatPool(size, stillness);
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    if (incoming.url === '/holders') {
      answerHolders(outgoing);
      return;
    }
    pooled(outgoing, (incoming.url ?? '').split('/')[2] ?? '', holderOf(incoming));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.env[HOST_ENV] = `http://127.0.0.1:${String(port)}`;
  try {
    await work();
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

await test('a worker takes every seat it declares at once, and one asking more than the pool is refused', async () =>
  withPool(5, async () => {
    const all = await holdBrowserSeat(5);
    await assert.rejects(holdBrowserSeat(6), /seat fewer than the 6 browserContexts declared/u);
    await assert.rejects(holdBrowserSeat(0), /seat fewer than the 0 browserContexts declared/u);
    const waiting = holdBrowserSeat(1);
    all();
    const one = await waiting;
    const [three, still] = await Promise.all([holdBrowserSeat(3), holdBrowserSeat(1)]);
    one();
    three();
    still();
  }));

/** A refusal no test here expects. */
const refused = (): string => 'refused';

await test('a seat wait given up says who holds the seats, by the names they gave', async () =>
  withPool(2, async () => {
    const url = new URL('/browser/2', process.env[HOST_ENV]);
    const holder = 'webkit/exclusive › a member’s Orbit ends (worker 3, pid 41)';
    const idle = await openHold(url, { held: 'seats', refused }, { who: holder });
    const giveUp = new AbortController();
    try {
      const waiting = openHold(
        url,
        { held: 'seats', refused },
        { signal: giveUp.signal, who: 'visual-01 › J8 (worker 5, pid 52)' },
      );
      await flush();
      giveUp.abort();
      await assert.rejects(waiting, {
        message:
          /^the wait for seats was given up before a grant: at its server, 2 of the Linux browsers' 2 seats held by webkit\/exclusive › a member’s Orbit ends \(worker 3, pid 41\) for \d+ s/u,
      });
    } finally {
      idle();
    }
  }));

/** A clock that moves only when told, ringing each alarm it passes. */
const manualClock = (): { readonly clock: Clock; readonly advance: (ms: number) => void } => {
  const state = { now: 0, alarms: new Set<{ readonly at: number; readonly ring: () => void }>() };
  return {
    clock: {
      now: () => state.now,
      after: (ms, ring) => {
        const alarm = { at: state.now + ms, ring };
        state.alarms.add(alarm);
        return () => {
          state.alarms.delete(alarm);
        };
      },
    },
    advance: (ms) => {
      state.now += ms;
      for (const alarm of [...state.alarms].filter(({ at }) => at <= state.now)) {
        state.alarms.delete(alarm);
        alarm.ring();
      }
    },
  };
};

await test('a seat wait outlives its bound while seats change hands, and fails once they stand still, naming who holds them', async () => {
  const { clock, advance } = manualClock();
  await withPool(
    1,
    async () => {
      const url = new URL('/browser/1', process.env[HOST_ENV]);
      const ask = async (who: string): Promise<() => void> =>
        openHold(url, { held: 'a seat', refused: () => 'the seat was refused' }, { who });
      const first = await ask('visual-01 › J1 (worker 1, pid 11)');
      const second = ask('webkit-09 › J5 (worker 2, pid 12)');
      const third = ask('visual-13 › J8 (worker 3, pid 13)');
      await flush();
      advance(900);
      first();
      const held = await second;
      advance(200);
      await flush();
      advance(1000);
      await assert.rejects(third, {
        message:
          /^the seat was refused: no seat changed hands in 1 s: .*1 of the Linux browsers' 1 seats held by webkit-09 › J5 \(worker 2, pid 12\)/u,
      });
      held();
    },
    { stall: 1000, clock },
  );
});

await test('a stack hold’s wait fails once no hold on its stack changes hands, and a CPU turn’s the same', async () => {
  const { clock, advance } = manualClock();
  const stillness = { stall: 1000, clock };
  const locks = stackLocks(stillness);
  await locks.take('t', 'own', new AbortController().signal);
  const sharer = locks.take('t', 'share', new AbortController().signal);
  const turns = semaphore(1, { stillness, what: 'no CPU turn' });
  await turns.take('run', 1, new AbortController().signal);
  const turn = turns.take('run', 1, new AbortController().signal);
  advance(999);
  await flush();
  advance(1);
  await assert.rejects(sharer, { message: /^no hold on t changed hands in 1 s: /u });
  await assert.rejects(turn, { message: /^no CPU turn changed hands in 1 s: /u });
  locks.give('t', 'own');
  await locks.take('t', 'share', new AbortController().signal);
});
