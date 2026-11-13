// The release audit (rules/budgets.md): a release's readings held to their budgets, and to the
// last release's, taken on the same machine, by a one-sided Mann-Whitney U test.
import { isObject, type JsonObject } from '../unknown.ts';
import { markdownTable } from './reporter.ts';
import { median } from './stats.ts';

/** One measure, with every run's reading. Counted work is the same each run and held exactly. */
export interface Reading {
  readonly name: string;
  readonly unit: string;
  readonly counted: boolean;
  readonly budget: number;
  readonly samples: readonly number[];
}

/** What a release keeps of its audit: the machine, so the next compares like with like. */
export interface Readings {
  readonly machine: string;
  readonly readings: readonly Reading[];
}

/** What the audit says of a measure that does not simply hold: a failure, or a note. */
interface Said {
  readonly failed: boolean;
  readonly reason: string;
}

export interface Verdict {
  readonly reading: Reading;
  readonly now: number;
  readonly spread: number;
  readonly last: number | undefined;
  readonly chance: number | undefined;
  readonly said: Said | undefined;
  readonly tighter: number | undefined;
}

/** The fewest runs a measure takes, and a budget is set from. */
const RUNS = 5;
const BUDGET_RUNS = 10;
/** The chance a regression is below. */
const SIGNIFICANCE = 0.01;
/** How much better than its budget a measure is before the budget tightens. */
const RATCHET = 0.9;
/** Median absolute deviations of noise a budget allows above its median. */
const NOISE = 3;
/** The most pairs the exact test counts out; past it, the normal approximation is as close. */
const EXACT_PAIRS = 900;

const failed = (reason: string): Said => ({ failed: true, reason });
const noted = (reason: string): Said => ({ failed: false, reason });

/** The median absolute deviation, unscaled. */
export const deviation = (values: readonly number[]): number => {
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
};

/** A pair's share of U: whether `ours` beats `theirs`, a tie counting a half. */
const won = (ours: number, theirs: number): number => {
  if (ours === theirs) {
    return 0.5;
  }
  return ours > theirs ? 1 : 0;
};

/** How many of `now` × `last` pairs `now` wins. */
const pairsWon = (now: readonly number[], last: readonly number[]): number =>
  now.reduce((sum, ours) => sum + last.reduce((wins, theirs) => wins + won(ours, theirs), 0), 0);

const choose = (from: number, taken: number): number => {
  let ways = 1;
  for (let index = 1; index <= taken; index += 1) {
    ways = (ways * (from - taken + index)) / index;
  }
  return ways;
};

/** `ways` of reaching each doubled U, moved on by `gained` and multiplied by `factor`, into `into`. */
const carry = (
  ways: ReadonlyMap<number, number>,
  [gained, factor]: [number, number],
  into: Map<number, number>,
): void => {
  for (const [twice, count] of ways) {
    into.set(twice + gained, (into.get(twice + gained) ?? 0) + count * factor);
  }
};

/** The chance `now` wins `wins` pairs or more, drawn at random from the pooled runs: each group
 *  of equal runs splits every way, a drawn run beating the undrawn below and tying its group's. */
const exactChance = (wins: number, now: readonly number[], last: readonly number[]): number => {
  const sizes = [...Map.groupBy([...now, ...last], (value) => value).entries()]
    .toSorted(([low], [high]) => low - high)
    .map(([, group]) => group.length);
  let byDrawn: Map<number, number>[] = [new Map([[0, 1]])];
  let seen = 0;
  for (const size of sizes) {
    const next = Array.from({ length: now.length + 1 }, () => new Map<number, number>());
    for (const [taken, reached] of byDrawn.entries()) {
      for (let drawn = 0; drawn <= Math.min(size, now.length - taken); drawn += 1) {
        const gained = drawn * (2 * (seen - taken) + size - drawn);
        carry(
          reached,
          [gained, choose(size, drawn)],
          next[taken + drawn] ?? new Map<number, number>(),
        );
      }
    }
    byDrawn = next;
    seen += size;
  }
  const all = [...(byDrawn[now.length] ?? new Map<number, number>()).entries()];
  const total = all.reduce((sum, [, count]) => sum + count, 0);
  const reach = all.filter(([twice]) => twice >= 2 * wins);
  return reach.reduce((sum, [, count]) => sum + count, 0) / total;
};

/** The standard normal's upper tail past `score` (Abramowitz and Stegun 7.1.26, to 1.5e-7). */
const upperTail = (score: number): number => {
  const scaled = Math.abs(score) / Math.SQRT2;
  const step = 1 / (1 + 0.3275911 * scaled);
  const terms = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const series = terms.reduceRight((sum, term) => (sum + term) * step, 0);
  const half = (series * Math.exp(-scaled * scaled)) / 2;
  return score >= 0 ? half : 1 - half;
};

/** The normal approximation, its variance corrected for ties and U by a half for continuity. */
const approximateChance = (
  wins: number,
  now: readonly number[],
  last: readonly number[],
): number => {
  const pairs = now.length * last.length;
  const total = now.length + last.length;
  const ties = [...Map.groupBy([...now, ...last], (value) => value).values()].reduce(
    (sum, group) => sum + group.length ** 3 - group.length,
    0,
  );
  const variance = (pairs / 12) * (total + 1 - ties / (total * (total - 1)));
  return variance === 0 ? 1 : upperTail((wins - pairs / 2 - 0.5) / Math.sqrt(variance));
};

/** How likely `now` would rank this far above `last` were they drawn alike: exact up to a few
 *  hundred pairs, ties included, else the normal approximation. */
export const regressionChance = (now: readonly number[], last: readonly number[]): number => {
  const wins = pairsWon(now, last);
  return now.length * last.length > EXACT_PAIRS
    ? approximateChance(wins, now, last)
    : exactChance(wins, now, last);
};

const countedSaid = (reading: Reading, now: number, last: number | undefined): Said | undefined => {
  if (reading.samples.some((sample) => sample !== now)) {
    return failed(`counted ${reading.samples.join(', ')}: counted work is the same each run`);
  }
  if (now > reading.budget) {
    return failed(`over its budget of ${String(reading.budget)}`);
  }
  return last !== undefined && now > last
    ? noted(`above the last release's ${String(last)}, within its budget`)
    : undefined;
};

/** What the last release counted, when it counted this. */
const lastCount = (before: Reading | undefined): number | undefined => {
  if (before === undefined) {
    return undefined;
  }
  return before.counted ? before.samples[0] : undefined;
};

/** Counted work is held exactly, so its budget is what it counts whenever that is less. */
const countedVerdict = (reading: Reading, before: Reading | undefined): Verdict => {
  const [now = Number.NaN] = reading.samples;
  const last = lastCount(before);
  const said = countedSaid(reading, now, last);
  const tighter = said === undefined && now < reading.budget ? now : undefined;
  return { reading, now, spread: 0, last, chance: undefined, said, tighter };
};

/** The last release's runs of a measure, when there are enough of them to judge noise by. */
const comparable = (before: Reading | undefined): readonly number[] | undefined =>
  before !== undefined && !before.counted && before.samples.length >= RUNS
    ? before.samples
    : undefined;

/** Over its budget is noise only beside a last release that held the budget and runs no faster
 *  by the test; otherwise it fails, as it does with no last release to judge it by. */
const measuredSaid = (
  reading: Reading,
  now: number,
  [last, chance]: [readonly number[] | undefined, number | undefined],
): Said | undefined => {
  const odds = chance === undefined ? '' : ` (p = ${chance.toFixed(4)})`;
  const slower = chance !== undefined && chance < SIGNIFICANCE;
  const over = `over its budget of ${String(reading.budget)}`;
  if (now <= reading.budget) {
    return slower ? noted(`slower than the last release${odds}, within its budget`) : undefined;
  }
  if (slower) {
    return failed(`${over}, and slower than the last release${odds}`);
  }
  return last !== undefined && median(last) <= reading.budget
    ? noted(`${over}, where the last release held it and ran no faster${odds}: noise`)
    : failed(over);
};

const measuredVerdict = (reading: Reading, before: Reading | undefined): Verdict => {
  const [now, spread] = [median(reading.samples), deviation(reading.samples)];
  const last = comparable(before);
  const chance = last === undefined ? undefined : regressionChance(reading.samples, last);
  const said =
    reading.samples.length < RUNS
      ? failed(
          `${String(reading.samples.length)} runs, where a measure takes ${String(RUNS)} or more`,
        )
      : measuredSaid(reading, now, [last, chance]);
  const ceiling = now + NOISE * spread;
  const enough = reading.samples.length >= BUDGET_RUNS;
  const tighter =
    said === undefined && enough && ceiling < reading.budget * RATCHET ? ceiling : undefined;
  const shownLast = last === undefined ? undefined : median(last);
  return { reading, now, spread, last: shownLast, chance, said, tighter };
};

/** The last release's readings of the same name and unit, when one machine took both. */
const before = (now: Readings, last: Readings | undefined): Map<string, Reading> => {
  const alike = last !== undefined && last.machine === now.machine ? last.readings : [];
  return new Map(alike.map((reading) => [reading.name, reading]));
};

/** Each of `now`'s readings judged, against `last`'s of the same name when one machine took both. */
export const audit = (now: Readings, last?: Readings): Verdict[] => {
  const earlier = before(now, last);
  return now.readings.map((reading) => {
    const match = earlier.get(reading.name);
    const kept = match !== undefined && match.unit === reading.unit ? match : undefined;
    return (reading.counted ? countedVerdict : measuredVerdict)(reading, kept);
  });
};

/** The measures the last release took on this machine that this run took none of. */
export const dropped = (now: Readings, last?: Readings): string[] => {
  const names = new Set(now.readings.map(({ name }) => name));
  return [...before(now, last).keys()].filter((name) => !names.has(name));
};

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isAmount = (value: unknown): value is number => Number.isFinite(value) && Number(value) >= 0;

const samplesOf = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((sample) => isAmount(sample))
    ? value
    : undefined;

const readingOf = (value: unknown, at: string): Reading => {
  const fields: JsonObject = isObject(value) ? value : {};
  const { name, unit, counted, budget } = fields;
  const samples = samplesOf(fields['samples']);
  if (isText(name) && isText(unit) && typeof counted === 'boolean' && isAmount(budget) && samples) {
    return { name, unit, counted, budget, samples };
  }
  const wrong = [
    [isText(name), 'a name'],
    [isText(unit), 'a unit'],
    [typeof counted === 'boolean', 'whether it is counted'],
    [isAmount(budget), 'a budget of 0 or more'],
    [samples !== undefined, 'samples of 0 or more'],
  ].flatMap(([held, what]) => (held === true ? [] : [String(what)]));
  throw new Error(`${at} lacks ${wrong.join(', ')}`);
};

/** `json` as a release's readings, refused whole with what is wrong at `source`. */
export const readingsOf = (json: unknown, source: string): Readings => {
  if (!isObject(json) || !isText(json['machine']) || !Array.isArray(json['readings'])) {
    throw new Error(`${source} holds no readings: a machine and a list of readings`);
  }
  const readings = json['readings'].map((value: unknown, index) =>
    readingOf(value, `${source}, reading ${String(index + 1)}`),
  );
  const names = readings.map(({ name }) => name);
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  if (readings.length === 0 || twice.length > 0) {
    throw new Error(
      `${source} holds ${readings.length === 0 ? 'no reading' : `${twice.join(', ')} twice`}`,
    );
  }
  return { machine: json['machine'], readings };
};

const parsed = (text: string, source: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is no JSON: ${String(error)}`, { cause: error });
  }
};

/** The readings `text` holds, as read from `source`. */
export const readingsFrom = (text: string, source: string): Readings =>
  readingsOf(parsed(text, source), source);

/** A count as it is, a measure to six significant figures; nothing for no value. */
const shown = (value: number | undefined, counted: boolean): string => {
  if (value === undefined) {
    return '';
  }
  return counted ? String(value) : String(Number(value.toPrecision(6)));
};

const rowOf = ({ reading, now, spread, last, chance, said }: Verdict): string[] => [
  reading.name,
  reading.unit,
  reading.counted ? shown(now, true) : `${shown(now, false)} ±${shown(spread, false)}`,
  shown(reading.budget, reading.counted),
  shown(last, reading.counted),
  chance === undefined ? '' : chance.toFixed(4),
  said === undefined ? 'ok' : `${said.failed ? 'fails' : 'ok'}: ${said.reason}`,
];

/** What the audit prints: a Markdown table of every measure, any it no longer takes, whether
 *  the last release was held to, and each budget that may tighten. */
export const report = (verdicts: readonly Verdict[], now: Readings, last?: Readings): string[] => [
  ...markdownTable([
    ['measure', 'unit', 'now (median ± MAD)', 'budget', 'last release', 'p', 'verdict'],
    ...verdicts.map((verdict) => rowOf(verdict)),
  ]),
  ...(last !== undefined && last.machine !== now.machine
    ? [`The last release was measured on ${last.machine}, not ${now.machine}: only budgets held.`]
    : []),
  ...dropped(now, last).map((name) => `${name}: measured by the last release, not by this run`),
  ...verdicts.flatMap(({ reading, tighter }) =>
    tighter === undefined
      ? []
      : [
          `${reading.name}: its budget may tighten to ${shown(tighter, reading.counted)} ${reading.unit}`,
        ],
  ),
];
