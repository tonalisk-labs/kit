// A timed test waits for a machine quiet of load kit's CPU gate never sees: a scripted sampler
// stands for the machine's counters, and moves a clock of its own by each window it reads.
import assert from 'node:assert/strict';
import type { CpuInfo } from 'node:os';
import { test } from 'node:test';

import {
  BOUND_MS,
  busyShare,
  CEILING,
  CEILING_ENV,
  ceilingOf,
  cpuSampler,
  QUIET_SAMPLES,
  quietBefore,
  WINDOW_MS,
} from '../src/floors/quiet.ts';

/** A machine whose busy shares come in `shares`, the last one lasting, each read taking a window
 *  of a clock that moves only as it is read; and what the wait said. */
const machine = (
  shares: readonly number[],
  { ceiling = CEILING, bound = BOUND_MS }: { ceiling?: number; bound?: number } = {},
): {
  readonly before: (what: string) => Promise<boolean>;
  readonly read: () => number;
  readonly said: string[];
} => {
  const state = { now: 0, read: 0 };
  const said: string[] = [];
  const before = quietBefore({
    sample: async () => {
      state.now += WINDOW_MS;
      state.read += 1;
      await Promise.resolve();
      return shares[Math.min(state.read, shares.length) - 1] ?? 0;
    },
    now: () => state.now,
    ceiling,
    bound,
    say: (line) => {
      said.push(line);
    },
  });
  return { before, read: () => state.read, said };
};

await test('a busy machine is waited out until it stays quiet, said twice', async () => {
  const { before, read, said } = machine([90, 80, 10, 10, 50, 10, 10, 10]);
  assert.equal(await before('a.perf.test.ts'), true);
  assert.equal(read(), 8);
  assert.deepEqual(said, [
    'a.perf.test.ts waits up to 45 s for the machine to go quiet: its CPU is 90% busy, over ' +
      `the 25% ceiling (${CEILING_ENV})`,
    'a.perf.test.ts goes on after 4 s: the machine is quiet, its CPU 10% busy',
  ]);
});

await test('a machine quiet at once goes on after a few samples, unsaid', async () => {
  const { before, read, said } = machine([25, 3, 12]);
  assert.equal(await before('a.perf.test.ts'), true);
  assert.deepEqual([read(), said], [QUIET_SAMPLES, []]);
});

await test('past the bound a busy machine goes on, said with its share', async () => {
  const { before, read, said } = machine([95], { bound: 4 * WINDOW_MS });
  assert.equal(await before('a.perf.test.ts'), false);
  assert.equal(read(), 4);
  assert.equal(said.length, 2);
  assert.equal(
    said[1],
    "a.perf.test.ts goes on, though the machine isn't quiet: its CPU is 95% busy, over the 25% " +
      'ceiling, past the 2 s a timed pass waits; judge a failing timing by that load',
  );
});

await test('a machine kept busy costs a pass 45 s once, and a lull 40 s in is caught', async () => {
  const busy = machine([95]);
  assert.equal(await busy.before('a.perf.test.ts'), false);
  assert.equal(busy.read(), 45_000 / WINDOW_MS);
  assert.match(busy.said.at(-1) ?? '', /, past the 45 s a timed pass waits;/u);
  const lull = machine([...Array.from({ length: 40_000 / WINDOW_MS }, () => 95), 10]);
  assert.equal(await lull.before('a.perf.test.ts'), true);
  assert.equal(lull.read(), 40_000 / WINDOW_MS + QUIET_SAMPLES);
});

await test('quiet samples past the bound still count towards quiet', async () => {
  const { before, read, said } = machine([95, 95, 10, 10, 10], { bound: 3 * WINDOW_MS });
  assert.equal(await before('a.perf.test.ts'), true);
  assert.deepEqual([read(), said.length], [5, 2]);
});

await test('the bound is the pass’s: once spent, a file reads once and goes on', async () => {
  const { before, read, said } = machine([95], { bound: 2 * WINDOW_MS });
  assert.equal(await before('a.perf.test.ts'), false);
  const first = read();
  assert.equal(await before('b.perf.test.ts'), false);
  assert.equal(read() - first, 1);
  assert.match(said.at(-1) ?? '', /^b\.perf\.test\.ts goes on, though the machine isn't quiet/u);
  assert.equal(said.filter((line) => line.startsWith('b.')).length, 1);
});

await test('the variable’s ceiling holds: 80% is quiet under 90; 100 never reads', async () => {
  const lax = machine([80], { ceiling: ceilingOf('90') });
  assert.deepEqual([await lax.before('a.perf.test.ts'), lax.read()], [true, QUIET_SAMPLES]);
  const strict = machine([80, 80, 20], { ceiling: ceilingOf('') });
  assert.deepEqual(
    [await strict.before('a.perf.test.ts'), strict.read()],
    [true, 2 + QUIET_SAMPLES],
  );
  const off = machine([100], { ceiling: ceilingOf('100') });
  assert.deepEqual([await off.before('a.perf.test.ts'), off.read(), off.said], [true, 0, []]);
});

await test('a ceiling is a whole percentage, the default unset, else refused', () => {
  assert.deepEqual(
    [undefined, '', '0', '7', '25', '100'].map((value) => ceilingOf(value)),
    [CEILING, CEILING, 0, 7, 25, 100],
  );
  for (const value of ['lots', '101', '-1', '2.5', '025', ' 25']) {
    assert.throws(
      () => ceilingOf(value),
      new RegExp(`^Error: ${CEILING_ENV} is a whole percentage from 0 to 100, not ${value}$`, 'u'),
    );
  }
});

/** A core whose counters read `busy` ticks spread over user, nice, system and interrupts, and
 *  `idle` idle ones. */
const core = (busy: number, idle: number): CpuInfo => ({
  model: 'core',
  speed: 0,
  times: { user: busy / 2, nice: busy / 4, sys: busy / 8, irq: busy / 8, idle },
});

await test('the busy share is all cores’ busy ticks over all their ticks', () => {
  const before = [core(800, 800), core(0, 1600), core(400, 0)];
  const after = [core(1400, 1200), core(0, 2600)];
  assert.equal(busyShare(before, after), 30);
  assert.equal(busyShare([], []), 0);
  assert.equal(busyShare(before, before), 0);
});

await test('a sample reads the counters either side of one window', async () => {
  const readings = [[core(0, 0)], [core(300, 700)]];
  const waits: number[] = [];
  const sample = cpuSampler(
    () => readings.shift() ?? [],
    async (ms) => {
      waits.push(ms);
      await Promise.resolve();
    },
  );
  assert.deepEqual([await sample(), waits, readings], [30, [WINDOW_MS], []]);
});
