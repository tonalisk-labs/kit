import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getDefaultHighWaterMark, Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { type TestContext, test } from 'node:test';

import { AHEAD_BYTES, type Link, shaper } from '../src/stack/shaping.ts';

const through = async (link: Link | undefined, chunks: readonly Buffer[]): Promise<string> =>
  text(Readable.from(chunks).pipe(shaper(link)));

await test('a shaped link delivers every byte of large chunks, in order', async () => {
  const link: Link = {
    profile: { rttMs: 1, kbps: 10_000_000, jitter: 0.5, socketLifetimeMs: undefined },
    free: 0,
  };
  const chunks = Array.from({ length: 4 }, () => Buffer.from(randomBytes(300_000).toString('hex')));
  assert.equal(await through(link, chunks), Buffer.concat(chunks).toString());
});

await test('an unshaped link passes bytes straight on', async () => {
  const chunks = [Buffer.from('one '), Buffer.from('two')];
  assert.equal(await through(undefined, chunks), 'one two');
  assert.equal(await through({ profile: undefined, free: 0 }, chunks), 'one two');
});

/** A link a slice takes over two minutes to cross, so none leaves while a test writes. */
const stopped = (): Link => ({
  profile: { rttMs: 100, kbps: 1, jitter: 0, socketLifetimeMs: undefined },
  free: 0,
});

/** How many bytes a shaper on a stopped link takes before it pushes back, slice by slice and at
 *  most twice the edge's bound. */
const takenAhead = (aheadBytes?: number): number => {
  const stream = shaper(stopped(), aheadBytes);
  const slice = Buffer.alloc(16 * 1024);
  let taken = slice.length;
  while (stream.write(slice) && taken < 2 * AHEAD_BYTES) {
    taken += slice.length;
  }
  stream.destroy();
  return taken;
};

await test('a shaper takes what it is told ahead of its link before pushing back, else the default', () => {
  assert.equal(takenAhead(AHEAD_BYTES), AHEAD_BYTES);
  assert.equal(takenAhead(), getDefaultHighWaterMark(false));
});

/** The performance clock and the timers held together, moved on by `advance`. */
const heldClock = (context: TestContext): ((ms: number) => Promise<void>) => {
  const clock = { now: 0 };
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(performance, 'now', () => clock.now);
  return async (ms) => {
    clock.now += ms;
    context.mock.timers.tick(ms);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };
};

await test('on a held clock, slices wait for their arrival, and the end waits for the queue', async (context) => {
  const advance = heldClock(context);
  // A slice takes 1 ms to send and 50 ms more to arrive.
  const link: Link = {
    profile: { rttMs: 100, kbps: 131_072, jitter: 0, socketLifetimeMs: undefined },
    free: 0,
  };
  const stream = shaper(link);
  const heard: string[] = [];
  stream.on('data', (bytes: Buffer) => {
    heard.push(bytes.toString());
  });
  const ended = new Promise((resolve) => {
    stream.on('end', resolve);
  });
  stream.write(Buffer.alloc(16 * 1024 + 1, 'a'));
  await advance(1);
  link.profile = undefined;
  stream.write(Buffer.from('z'));
  stream.end();
  await advance(1);
  assert.deepEqual(heard, [], 'nothing arrives before its time, an unshaped write included');
  await advance(100);
  await ended;
  assert.equal(heard.join(''), `${'a'.repeat(16 * 1024 + 1)}z`);
});
