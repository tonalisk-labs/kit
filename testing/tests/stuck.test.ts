// The watch over a test's progress (stuck.ts): a wait that nothing answers is stuck once STILL_MS
// passes, naming what last moved; a test that moves, however slowly, never is; nor is one whose
// worker works with no page event, as a Lighthouse report is written.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STILL_MS, stuckProblem, watchProgress } from '../src/stuck.ts';
import { manualClock } from './manual-clock.ts';

/** A watch on the manual clock, its worker's processor time set by the test, in µs. */
const watched = (): {
  readonly progress: ReturnType<typeof watchProgress>;
  readonly advance: (ms: number) => void;
  readonly work: (us: number) => void;
  readonly stuck: string[];
} => {
  const { clock, advance } = manualClock();
  const worker = { spent: 0 };
  const stuck: string[] = [];
  const progress = watchProgress({
    clock,
    spent: () => worker.spent,
    stuck: (last) => {
      stuck.push(last);
    },
  });
  return {
    progress,
    advance,
    work: (us) => {
      worker.spent += us;
    },
    stuck,
  };
};

await test('a wait that nothing answers is stuck at the bound, naming what last moved', () => {
  const { progress, advance, stuck } = watched();
  progress.moved('GET /api/v1/journey answered');
  advance(STILL_MS - 1);
  assert.deepEqual(stuck, [], 'not before the bound');
  advance(1);
  assert.deepEqual(stuck, ['GET /api/v1/journey answered']);
  advance(10 * STILL_MS);
  assert.deepEqual(
    stuck.map((last) => stuckProblem(last).message),
    ['the test stood still for 132 s: nothing moved after GET /api/v1/journey answered'],
    'said once, naming it',
  );
});

await test('a test that moves, however slowly, is never stuck, however long it runs', () => {
  const { progress, advance, stuck } = watched();
  for (let step = 0; step < 100; step += 1) {
    advance(STILL_MS - 1);
    progress.moved(`step ${String(step)}`);
  }
  assert.deepEqual(stuck, [], '100 quiet stretches each just under the bound');
});

await test('a worker that works with no page event is not stuck, until its work stops', () => {
  const { advance, work, stuck } = watched();
  for (let stretch = 0; stretch < 5; stretch += 1) {
    work(STILL_MS);
    advance(STILL_MS);
  }
  assert.deepEqual(stuck, [], 'five stretches of the worker’s own work, a thousandth of a core');
  work(STILL_MS - 1);
  advance(STILL_MS);
  assert.deepEqual(stuck, ['the test began'], 'less than a thousandth of a core is standing still');
});

await test('a watch stopped as its test ends says nothing after', () => {
  const { progress, advance, stuck } = watched();
  progress.stop();
  advance(10 * STILL_MS);
  progress.moved('a late frame');
  advance(10 * STILL_MS);
  assert.deepEqual(stuck, []);
});
