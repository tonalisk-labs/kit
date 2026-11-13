// The release audit: a reading over its budget fails unless a last release that held the budget
// shows it noise, by a Mann-Whitney U test at p < 0.01 on the same machine; counted work is held
// exactly; and a budget measured well under from 10 runs is offered to tighten.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  audit,
  deviation,
  dropped,
  type Reading,
  type Readings,
  readingsFrom,
  readingsOf,
  regressionChance,
  report,
  type Verdict,
} from '../src/perf/audit.ts';
import { median } from '../src/perf/stats.ts';

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

const alone = (reading: Reading): Verdict => verdictOf(on('mac', reading));
const against = (reading: Reading, last: Reading): Verdict =>
  verdictOf(on('mac', reading), on('mac', last));
const saying = ({ said }: Verdict): string =>
  said === undefined ? 'holds' : `${said.failed ? 'fails' : 'notes'}: ${said.reason}`;
/** What the audit says of `reading`, alone or against `last` from the same machine. */
const says = (reading: Reading, last?: Reading): string =>
  saying(last === undefined ? alone(reading) : against(reading, last));
/** `length` whole numbers on from `start`. */
const series = (start: number, length: number): number[] =>
  [...Array.from({ length }).keys()].map((index) => start + index);
/** Ten runs cycling through five on from `start`. */
const ten = (start: number): number[] => series(0, 10).map((index) => start + (index % 5));
/** The budget `samples` may tighten it to, alone. */
const tighter = (samples: number[]): number | undefined => alone(measure(samples)).tighter;
/** `reading` as another of its fields would make it. */
const changed = (reading: Reading, change: Readonly<Record<string, unknown>>): unknown =>
  Object.fromEntries([...Object.entries(reading), ...Object.entries(change)]);

const OVER = [101, 102, 103, 104, 105];
const HELD = [90, 91, 92, 93, 94];

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

await test('ties are counted exactly, as every split of the pooled runs gives them', () => {
  // Each against counting every split of the pooled runs.
  assert.equal(regressionChance([2, 2, 2, 3, 3, 3], [1, 1, 1, 2, 2, 2]).toFixed(9), '0.021645022');
  assert.equal(regressionChance([5, 3, 5, 3, 5], [0, 3, 2, 2, 1]).toFixed(9), '0.011904762');
  assert.equal(regressionChance([1, 1, 1, 2, 2, 2], [2, 2, 2, 3, 3, 3]), 1);
  assert.equal(regressionChance([4, 4, 4, 4, 4], [4, 4, 4, 4, 4]), 1);
});

await test('a lopsided pair of samples is counted exactly, whichever is the larger', () => {
  assert.equal(regressionChance(series(100, 180), series(0, 5)).toPrecision(6), '5.84777e-10');
  assert.equal(regressionChance(series(1000, 5), series(0, 180)).toPrecision(6), '5.84777e-10');
});

await test('900 pairs are counted exactly, and more take the normal approximation', () => {
  const apart = series(0, 30);
  const later = series(30, 30);
  assert.equal(regressionChance(later, apart).toPrecision(6), '8.45562e-18');
  // Against the same approximation worked out apart, with Python's math.erfc, ties and all.
  const now = series(0, 31).map((index) => 10 + (index % 7));
  const last = series(0, 30).map((index) => 9 + (index % 7));
  assert.equal(regressionChance(now, last).toFixed(6), '0.040311');
  assert.equal(regressionChance([...last, 9], now.slice(0, 30)).toFixed(6), '0.975288');
});

await test('a measure over its budget fails with no last release, and one at or under it holds', () => {
  assert.equal(says(measure(OVER)), 'fails: over its budget of 100');
  assert.equal(says(measure([96, 98, 100, 102, 104])), 'holds');
  assert.equal(alone(measure(HELD)).now, 92);
});

await test('a measure takes five runs', () => {
  assert.equal(says(measure([1, 2, 3, 4])), 'fails: 4 runs, where a measure takes 5 or more');
});

await test('over its budget is noise only beside a last release that held it and ran no faster', () => {
  const slower = against(measure(OVER), measure(HELD));
  assert.equal(
    saying(slower),
    `fails: over its budget of 100, and slower than the last release (p = ${(1 / 252).toFixed(4)})`,
  );
  assert.equal(slower.last, 92);
  const noise = says(measure([99, 100, 101, 102, 103]), measure([96, 97, 98, 99, 100]));
  assert.equal(
    noise,
    'notes: over its budget of 100, within the noise of the last release, which held it (p = 0.0198)',
  );
  // One slow run of the last release can't excuse a median far past its own and its noise.
  const outlier = says(measure([101, 150, 1000, 1000, 1000]), measure([96, 97, 98, 99, 200]));
  assert.equal(outlier, 'fails: over its budget of 100');
  // A last release over its budget too can't excuse it, so a slow creep fails.
  assert.equal(
    says(measure(OVER), measure([100, 101, 102, 104, 106])),
    'fails: over its budget of 100',
  );
});

await test('a last release too thin, counted or elsewhere judges nothing', () => {
  assert.equal(says(measure(OVER), measure([10, 11, 12])), 'fails: over its budget of 100');
  const countedBefore: Reading = {
    name: 'open a note',
    unit: 'ms',
    counted: true,
    budget: 100,
    samples: [5],
  };
  assert.equal(says(measure(OVER), countedBefore), 'fails: over its budget of 100');
  const countedFive: Reading = {
    name: 'open a note',
    unit: 'ms',
    counted: true,
    budget: 100,
    samples: [99, 99, 99, 99, 99],
  };
  assert.equal(says(measure(OVER), countedFive), 'fails: over its budget of 100');
  const inSeconds: Reading = {
    name: 'open a note',
    unit: 's',
    counted: false,
    budget: 100,
    samples: HELD,
  };
  assert.equal(says(measure(OVER), inSeconds), 'fails: over its budget of 100');
  const elsewhere = verdictOf(on('mac', measure(OVER)), on('linux', measure(HELD)));
  assert.equal(saying(elsewhere), 'fails: over its budget of 100');
  assert.equal(elsewhere.last, undefined);
});

await test('slower than the last release within its budget is noted, not failed', () => {
  assert.equal(
    says(measure([60, 61, 62, 63, 64]), measure([50, 51, 52, 53, 54])),
    `notes: slower than the last release (p = ${(1 / 252).toFixed(4)}), within its budget`,
  );
});

await test('counted work is held exactly to its budget, and a rise within it is noted', () => {
  const measuredBefore: Reading = {
    name: 'allocations a keystroke',
    unit: 'blocks',
    counted: false,
    budget: 100,
    samples: [80, 81, 82, 83, 84],
  };
  const beside = against(counted([90]), measuredBefore);
  assert.equal(saying(beside), 'holds');
  assert.equal(beside.last, undefined);
  assert.equal(says(counted([10, 11])), 'fails: counted 10, 11: counted work is the same each run');
  assert.equal(says(counted([101])), 'fails: over its budget of 100');
  const risen = against(counted([90]), counted([80]));
  assert.equal(saying(risen), "notes: above the last release's 80, within its budget");
  assert.equal(risen.tighter, 90);
  const same = against(counted([100]), counted([100]));
  assert.equal(saying(same), 'holds');
  assert.equal(same.tighter, undefined);
  assert.equal(alone(counted([90])).tighter, 90);
});

await test('a budget tightens only from 10 runs, and only when more than 10% better', () => {
  assert.equal(tighter([60, 61, 62, 63, 64]), undefined);
  assert.equal(tighter(ten(60)), 65);
  // The median and its noise come to exactly 90: not more than 10% better.
  assert.equal(tighter(ten(85)), undefined);
  assert.equal(tighter(ten(84)), 89);
});

await test('the report shows counts exactly, and every measure, machine and budget to tighten', () => {
  const big: Reading = {
    name: 'bytes a sync',
    unit: 'blocks',
    counted: true,
    budget: 1_234_568,
    samples: [1_234_567],
  };
  const now = on('mac', measure([60, 61, 62, 63, 64]), big);
  const lines = report(audit(now), now);
  assert.equal(
    lines[0],
    '| measure | unit | now (median ± MAD) | budget | last release | p | verdict |',
  );
  assert.equal(lines[2], '| open a note | ms | 62 ±1 | 100 |  |  | ok |');
  assert.equal(lines[3], '| bytes a sync | blocks | 1234567 | 1234568 |  |  | ok |');
  assert.ok(lines.includes('bytes a sync: its budget may tighten to 1234567 blocks'));
  const last = on('linux', measure(HELD));
  assert.ok(
    report(audit(now, last), now, last).includes(
      'The last release was measured on linux, not mac: only budgets held.',
    ),
  );
  const failing = on('mac', measure(OVER));
  assert.equal(
    report(audit(failing), failing)[2],
    '| open a note | ms | 103 ±1 | 100 |  |  | fails: over its budget of 100 |',
  );
});

await test('a measure the last release took and this run did not is named', () => {
  const now = on('mac', measure(HELD));
  const last = on('mac', measure(HELD), counted([5]));
  assert.deepEqual(
    dropped(now, last).map(({ name }) => name),
    ['allocations a keystroke'],
  );
  assert.ok(
    report(audit(now, last), now, last).includes(
      'allocations a keystroke: measured by the last release in blocks, not by this run',
    ),
  );
  const inSeconds = on('mac', {
    name: 'open a note',
    unit: 's',
    counted: false,
    budget: 100,
    samples: HELD,
  });
  assert.deepEqual(
    dropped(inSeconds, last).map(({ name, unit }) => `${name} in ${unit}`),
    ['open a note in ms', 'allocations a keystroke in blocks'],
  );
  const elsewhere = on('linux', counted([5]));
  assert.deepEqual(dropped(now, elsewhere), []);
});

await test('readings are read whole, or refused with what is wrong and where', () => {
  const reading = { name: 'n', unit: 'ms', counted: false, budget: 5, samples: [1] };
  assert.deepEqual(readingsOf({ machine: 'mac', readings: [reading] }, 'now.json'), {
    machine: 'mac',
    readings: [reading],
  });
  const lacks = (change: Readonly<Record<string, unknown>>, what: string): void => {
    assert.throws(
      () => readingsOf({ machine: 'mac', readings: [changed(reading, change)] }, 'now.json'),
      new RegExp(`^Error: now\\.json, reading 1 lacks ${what}$`, 'u'),
    );
  };
  lacks({ name: '' }, 'a name');
  lacks({ unit: 7 }, 'a unit');
  lacks({ counted: 'yes' }, 'whether it is counted');
  lacks({ budget: -1 }, 'a budget of 0 or more');
  lacks({ samples: [] }, 'one sample or more, each 0 or more');
  lacks({ samples: [1, -2] }, 'one sample or more, each 0 or more');
  assert.throws(() => readingsOf([], 'now.json'), /^Error: now\.json holds no readings/u);
  assert.throws(
    () => readingsOf({ machine: '', readings: [reading] }, 'now.json'),
    /holds no readings/u,
  );
  assert.throws(
    () => readingsOf({ machine: 'mac', readings: [] }, 'now.json'),
    /^Error: now\.json holds no reading$/u,
  );
  assert.throws(
    () => readingsOf({ machine: 'mac', readings: [reading, reading, reading] }, 'now.json'),
    /^Error: now\.json holds n twice$/u,
  );
  assert.throws(() => readingsFrom('{', 'now.json'), /^Error: now\.json is no JSON: /u);
});
