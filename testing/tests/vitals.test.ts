import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Shift } from '../src/perf/collector.ts';
import { clsWindow, heldOverBudget, timedOverBudget, WALL_CLOCK } from '../src/perf/vitals.ts';

const shift = (at: number, value: number): Shift => [at, value, []];

await test('the CLS window is the largest run split by 1 s gaps and 5 s spans', () => {
  assert.deepEqual(clsWindow([]), []);
  const shifts = [shift(0, 0.1), shift(500, 0.1), shift(3000, 0.05), shift(3500, 0.3)];
  assert.deepEqual(clsWindow(shifts), [shift(3000, 0.05), shift(3500, 0.3)]);
  const equal = [shift(0, 0.2), shift(2000, 0.2)];
  assert.deepEqual(clsWindow(equal), [shift(0, 0.2)]);
});

await test('layout shift and CPU time are held; the wall clock’s timings are only reported', () => {
  const metrics = {
    'cumulative-layout-shift': 0.3,
    'interaction-cpu': 80,
    'interaction-to-next-paint': 2552,
    'largest-contentful-paint': 3000,
    'time-to-first-byte': 100,
  };
  assert.deepEqual(heldOverBudget(metrics, ['main (0.300; down)']), [
    'cumulative-layout-shift 0.300 is over its budget of 0.1; moved: main (0.300; down)',
    'interaction-cpu 80.000 is over its budget of 50',
  ]);
  assert.deepEqual(timedOverBudget(metrics), [
    'interaction-to-next-paint 2552.000 is over its budget of 200',
    'largest-contentful-paint 3000.000 is over its budget of 2500',
  ]);
  assert.deepEqual(
    heldOverBudget({ 'cumulative-layout-shift': 0.05, 'interaction-cpu': 12 }),
    [],
    'within budget',
  );
  for (const id of ['first-contentful-paint', 'total-blocking-time', 'speed-index']) {
    assert.equal(WALL_CLOCK.has(id), true, id);
  }
});
