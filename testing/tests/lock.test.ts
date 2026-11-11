import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { HOST_ENV, holdBrowserSeat } from '../src/stack/control.ts';
import { answerHolders, holderOf } from '../src/stack/gate-server.ts';
import { openHold } from '../src/stack/hold.ts';
import { seatPool, stackLocks } from '../src/stack/lock.ts';

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

/** A pool of `size` seats served as the stack host serves its browsers' seats, for `work`. */
const withPool = async (size: number, work: () => Promise<void>): Promise<void> => {
  const pooled = seatPool(size);
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

await test('a seat wait past its bound fails, naming who holds the seats and who waits', async () =>
  withPool(2, async () => {
    const url = new URL('/browser/2', process.env[HOST_ENV]);
    const idle = await openHold(url, { held: 'seats', refused }, { who: 'an idle worker' });
    try {
      await assert.rejects(
        openHold(url, { held: 'seats', refused, bound: 50 }, { who: 'a visual test' }),
        /^Error: seats was not granted within 0\.05 s: at its server, 2 of the Linux browsers' 2 seats held by an idle worker for \d+ s; 2 of the Linux browsers' 2 seats waited for by a visual test for \d+ s$/u,
      );
    } finally {
      idle();
    }
  }));
