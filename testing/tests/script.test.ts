import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  environment,
  field,
  inPool,
  inTurn,
  isObject,
  items,
  messageOf,
  numberOf,
  runScript,
  text,
} from '../src/script.ts';

/** Work already done with `value`, settled with no turn of the loop. */
const finished = async <Value>(value: Value): Promise<Value> => {
  const { promise, resolve } = Promise.withResolvers<Value>();
  resolve(value);
  return promise;
};

/** Work that always fails. */
const fails = async (): Promise<number> => {
  const { promise, reject } = Promise.withResolvers<number>();
  reject(new Error('broken'));
  return promise;
};

await test('steps run in turn until one fails, and its status is the answer', async () => {
  const ran: number[] = [];
  const step = (status: number) => async (): Promise<number> => {
    ran.push(status);
    return finished(status);
  };
  assert.equal(await inTurn([step(0), step(3), step(0)]), 3);
  assert.deepEqual(ran, [0, 3]);
  assert.equal(await inTurn([]), 0);
});

await test('a pool answers in item order and holds no more than its size at once', async () => {
  const stop = new AbortController().signal;
  const finishes = [1, 2, 3].map(() => Promise.withResolvers<boolean>());
  const finishOf = (item: number): PromiseWithResolvers<boolean> => {
    const found = finishes[item - 1];
    if (found === undefined) {
      throw new Error(`no item ${String(item)}`);
    }
    return found;
  };
  const pool = { open: 0, most: 0 };
  const work = async (item: number): Promise<number> => {
    pool.open += 1;
    pool.most = Math.max(pool.most, pool.open);
    await finishOf(item).promise;
    pool.open -= 1;
    return item * 2;
  };
  const answered = inPool([1, 2, 3], work, { size: 2, stop });
  // The second item finishes first, and the third takes its place before the first finishes.
  for (const item of [2, 3, 1]) {
    finishOf(item).resolve(true);
  }
  assert.deepEqual(await answered, [2, 4, 6]);
  assert.equal(pool.most, 2);
});

await test('a pool takes no item once stopped, and passes on a failure', async () => {
  const stopped = new AbortController();
  stopped.abort('SIGINT');
  await assert.rejects(
    inPool([1], fails, { stop: stopped.signal }),
    (reason) => reason === 'SIGINT',
  );
  const stop = new AbortController().signal;
  await assert.rejects(inPool([1], fails, { stop }), /broken/u);
});

await test('JSON of unknown shape is read without casts', () => {
  const parsed: unknown = JSON.parse('{"name":"vega","size":3,"list":[1],"nan":"x"}');
  assert.ok(isObject(parsed));
  assert.equal(isObject(JSON.parse('null')), false);
  assert.equal(text(parsed, 'name'), 'vega');
  assert.equal(text(parsed, 'size'), '');
  assert.equal(numberOf(parsed, 'size'), 3);
  assert.equal(numberOf(parsed, 'nan'), undefined);
  assert.deepEqual(items(field(parsed, 'list')), [1]);
  assert.deepEqual(items(field('not an object', 'list')), []);
});

await test('an error reads with its causes, and anything else as its string', () => {
  const error = new Error('fetch failed', { cause: new Error('connect ECONNREFUSED') });
  assert.equal(messageOf(error), 'fetch failed: connect ECONNREFUSED');
  assert.equal(messageOf(7), '7');
});

await test('a child environment is this one with the given variables on top', () => {
  const child = environment({ KIT_SCRIPT_TEST: 'set' });
  assert.equal(child['KIT_SCRIPT_TEST'], 'set');
  assert.equal(process.env['KIT_SCRIPT_TEST'], undefined);
});

await test('a script exits with its task’s status, and a failure that no stop caused throws', async () => {
  try {
    await runScript('a-script', async () => finished(4));
    assert.equal(process.exitCode, 4);
  } finally {
    process.exitCode = 0;
  }
  await assert.rejects(runScript('a-script', fails), /broken/u);
});
