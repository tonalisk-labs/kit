// The release audit: a reading over its budget fails, as does one the last release's beats on
// the same machine by a Mann-Whitney U test at p < 0.01; counted work is held exactly; and a
// budget measured well under is offered to tighten.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  audit,
  deviation,
  median,
  type Reading,
  type Readings,
  readingsOf,
  regressionChance,
  report,
  type Verdict,
} from '../src/perf/audit.ts';

const measure = (samples: number[], budget = 100): Reading => ({
  name: 'open a note',
  unit: 'ms',
  counted: false,
  budget,
  samples,
});

const counted = (samples: number[], budget = 100): Reading => ({
  name: 'allocations a keystroke',
  unit: 'blocks',
  counted: true,
  budget,
  samples,
});

const on = (machine: string, ...readings: Reading[]): Readings => ({ machine, readings });

/** The one verdict on `now`'s one reading. */
const verdictOf = (now: Readings, last?: Readings): Verdict => {
  const [verdict] = audit(now, last);
  assert.ok(verdict);
  return verdict;
};

/** The verdict on `reading` alone, or against `last` taken on the same machine. */
const alone = (reading: Reading): Verdict => verdictOf(on('mac', reading));
const against = (reading: Reading, last: Reading): Verdict =>
  verdictOf(on('mac', reading), on('mac', last));

await test('the median and its absolute deviation', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(deviation([1, 2, 3, 4, 100]), 1);
});

await test('the exact test: five runs apart are significant, four are not', () => {
  assert.equal(regressionChance([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]), 1 / 252);
  assert.equal(regressionChance([5, 6, 7, 8], [1, 2, 3, 4]), 1 / 70);
  assert.equal(regressionChance([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 1);
  const mixed = regressionChance([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]);
  assert.ok(mixed > 0.5 && mixed < 0.8, String(mixed));
});

await test('tied runs take the normal approximation', () => {
  const apart = regressionChance([2, 2, 2, 3, 3, 3], [1, 1, 1, 2, 2, 2]);
  assert.ok(apart < 0.02 && apart > 0.001, String(apart));
  assert.equal(regressionChance([4, 4, 4, 4, 4], [4, 4, 4, 4, 4]), 1);
});

await test('a measure over its budget fails, and one under it passes', () => {
  assert.equal(alone(measure([101, 102, 103, 104, 105])).failure, 'over its budget of 100');
  const under = alone(measure([90, 91, 92, 93, 94]));
  assert.equal(under.failure, undefined);
  assert.equal(under.now, 92);
});

await test('a measure takes five runs', () => {
  assert.equal(alone(measure([1, 2, 3, 4])).failure, '4 runs, where a measure takes 5 or more');
});

await test('over its budget fails unless the last release was as slow, and only on one machine', () => {
  const now = measure([101, 102, 103, 104, 105]);
  assert.equal(
    against(now, measure([90, 91, 92, 93, 94])).failure,
    `over its budget of 100, and slower than the last release (p = ${(1 / 252).toFixed(4)})`,
  );
  const noise = against(now, measure([100, 102, 104, 106, 108]));
  assert.equal(noise.failure, undefined);
  assert.match(
    noise.note ?? '',
    /^over its budget of 100, as the last release was \(p = 0\.\d+\): noise$/u,
  );
  const elsewhere = verdictOf(on('mac', now), on('linux', measure([100, 102, 104, 106, 108])));
  assert.equal(elsewhere.failure, 'over its budget of 100');
  assert.equal(elsewhere.last, undefined);
});

await test('slower than the last release within its budget is noted, not failed', () => {
  const slower = against(measure([60, 61, 62, 63, 64]), measure([50, 51, 52, 53, 54]));
  assert.equal(slower.failure, undefined);
  assert.equal(slower.last, 52);
  assert.equal(
    slower.note,
    `slower than the last release (p = ${(1 / 252).toFixed(4)}), within its budget`,
  );
});

await test('counted work is held exactly, to its budget and to the last release', () => {
  assert.equal(
    alone(counted([10, 11])).failure,
    'counted 10, 11: counted work is the same each run',
  );
  assert.equal(alone(counted([101])).failure, 'over its budget of 100');
  assert.equal(against(counted([90]), counted([80])).failure, 'above the last release');
  const same = against(counted([100]), counted([100]));
  assert.equal(same.failure, undefined);
  assert.equal(same.tighter, undefined);
});

await test('a budget measured well under is offered to tighten to the median and its noise', () => {
  assert.equal(alone(counted([90])).tighter, 90);
  assert.equal(alone(measure([88, 89, 90, 91, 92])).tighter, undefined);
  assert.equal(alone(measure([60, 61, 62, 63, 64])).tighter, 65);
});

await test('the report tables every measure, the machine, and each budget that may tighten', () => {
  const now = on('mac', measure([60, 61, 62, 63, 64]), counted([101]));
  const last = on('linux', measure([60, 61, 62, 63, 64]));
  const lines = report(audit(now, last), now, last);
  assert.equal(lines[0], '| measure | unit | now | budget | last release | p | verdict |');
  assert.equal(lines[2], '| open a note | ms | 62 ±1 | 100 |  |  | ok |');
  assert.equal(
    lines[3],
    '| allocations a keystroke | blocks | 101 | 100 |  |  | over its budget of 100 |',
  );
  assert.ok(lines.includes('The last release was measured on linux, not mac: only budgets held.'));
  assert.ok(lines.includes('open a note: its budget may tighten to 65 ms'));
});

await test('readings are read whole, or refused with where they went wrong', () => {
  const json: unknown = JSON.parse(
    '{"machine":"mac","readings":[{"name":"n","unit":"ms","counted":false,"budget":5,"samples":[1]}]}',
  );
  assert.deepEqual(readingsOf(json, 'now.json'), {
    machine: 'mac',
    readings: [{ name: 'n', unit: 'ms', counted: false, budget: 5, samples: [1] }],
  });
  assert.throws(() => readingsOf([], 'now.json'), /now\.json holds no readings/u);
  assert.throws(
    () => readingsOf({ machine: 'mac', readings: [{ name: 'n', samples: [] }] }, 'now.json'),
    /now\.json, reading 1 is no reading/u,
  );
});
