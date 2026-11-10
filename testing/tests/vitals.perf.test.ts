// Run alone and uninstrumented, its budget in CPU time, as every timed test is.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Shift } from '../src/perf/collector.ts';
import { clsWindow } from '../src/perf/vitals.ts';
import { cpuClock } from './cpu.ts';

const shift = (at: number, value: number): Shift => [at, value, []];

const total = (run: readonly Shift[]): number => run.reduce((sum, [, value]) => sum + value, 0);

// The reference: windows sorted by total, largest first, the earliest of equals kept.
const sortedWindow = (shifts: readonly Shift[]): readonly Shift[] => {
  const windows: Shift[][] = [];
  for (const each of shifts) {
    const current = windows.at(-1) ?? [];
    const [first] = current[0] ?? [each[0]];
    const [last] = current.at(-1) ?? [each[0]];
    if (current.length > 0 && each[0] - last < 1000 && each[0] - first < 5000) {
      current.push(each);
    } else {
      windows.push([each]);
    }
  }
  return windows.toSorted((left, right) => total(right) - total(left))[0] ?? [];
};

await test('the CLS window matches the sorted form on many runs, in one pass', () => {
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const shifts: Shift[] = [];
  let at = 0;
  for (let index = 0; index < 20_000; index += 1) {
    at += Math.floor(random() * 1500);
    const value = Math.round(random() * 100) / 1000;
    shifts.push(shift(at, value));
  }
  const spent = cpuClock();
  const found = clsWindow(shifts);
  const took = spent();
  assert.ok(took < 100, `${String(Math.round(took))} ms of CPU`);
  assert.deepEqual(found, sortedWindow(shifts));
});
