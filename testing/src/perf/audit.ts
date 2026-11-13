// The release audit (rules/budgets.md): a release's readings held to their budgets, and to the
// last release's, taken on the same machine, by a one-sided Mann-Whitney U test.
import { isObject } from '../unknown.ts';
import { markdownTable } from './reporter.ts';

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

/** A measure's verdict, and the budget it may tighten to. */
export interface Verdict {
  readonly reading: Reading;
  readonly now: number;
  readonly spread: number;
  readonly last: number | undefined;
  readonly chance: number | undefined;
  readonly failure: string | undefined;
  readonly note: string | undefined;
  readonly tighter: number | undefined;
}

/** The fewest runs a measure that varies takes, and the chance a regression is below. */
const RUNS = 5;
const SIGNIFICANCE = 0.01;
/** How much better than its budget a measure is before the budget tightens. */
const RATCHET = 0.9;
/** Median absolute deviations of noise a budget allows above its median. */
const NOISE = 3;
/** The most pairs the exact test counts out; past it, the normal approximation is close. */
const EXACT_PAIRS = 400;

export const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((low, high) => low - high);
  const half = Math.floor(sorted.length / 2);
  const middle = sorted[half] ?? Number.NaN;
  return sorted.length % 2 === 1 ? middle : ((sorted[half - 1] ?? Number.NaN) + middle) / 2;
};

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

/** How many orderings of the samples' sizes give each U, untied: by the smallest value, one of
 *  the first wins no pair, and one of the second loses to every value of the first. */
const orderings = (firstSize: number, secondSize: number): number[] => {
  let rows: number[][] = Array.from({ length: firstSize + 1 }, () => [1]);
  for (let second = 1; second <= secondSize; second += 1) {
    const next: number[][] = [[1]];
    for (let first = 1; first <= firstSize; first += 1) {
      const counts = Array.from<number>({ length: first * second + 1 }).fill(0);
      for (const [wins, ways] of (next[first - 1] ?? []).entries()) {
        counts[wins] = (counts[wins] ?? 0) + ways;
      }
      for (const [wins, ways] of (rows[first] ?? []).entries()) {
        counts[wins + first] = (counts[wins + first] ?? 0) + ways;
      }
      next.push(counts);
    }
    rows = next;
  }
  return rows[firstSize] ?? [];
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

/** How likely `now` would rank this far above `last` were they drawn alike: exact with no ties
 *  among a few hundred pairs, else the normal approximation. */
export const regressionChance = (now: readonly number[], last: readonly number[]): number => {
  const wins = pairsWon(now, last);
  const tied = new Set([...now, ...last]).size < now.length + last.length;
  if (tied || now.length * last.length > EXACT_PAIRS) {
    return approximateChance(wins, now, last);
  }
  const counts = orderings(now.length, last.length);
  const all = counts.reduce((sum, ways) => sum + ways, 0);
  return counts.slice(Math.ceil(wins)).reduce((sum, ways) => sum + ways, 0) / all;
};

const countedFailure = (
  reading: Reading,
  now: number,
  last: number | undefined,
): string | undefined => {
  if (reading.samples.some((sample) => sample !== now)) {
    return `counted ${reading.samples.join(', ')}: counted work is the same each run`;
  }
  if (now > reading.budget) {
    return `over its budget of ${String(reading.budget)}`;
  }
  return last !== undefined && now > last ? 'above the last release' : undefined;
};

const countedVerdict = (reading: Reading, before: Reading | undefined): Verdict => {
  const [now = Number.NaN] = reading.samples;
  const last = before === undefined ? undefined : before.samples[0];
  const failure = countedFailure(reading, now, last);
  const tighter = failure === undefined && now < reading.budget ? now : undefined;
  return { reading, now, spread: 0, last, chance: undefined, failure, note: undefined, tighter };
};

/** What a measure fails on, or what is noted of it: over its budget fails only when the last
 *  release's runs, if any, show it significantly slower, so noise alone never fails a change. */
const measuredJudgement = (
  reading: Reading,
  now: number,
  chance: number | undefined,
): [string | undefined, string | undefined] => {
  if (reading.samples.length < RUNS) {
    return [
      `${String(reading.samples.length)} runs, where a measure takes ${String(RUNS)} or more`,
      undefined,
    ];
  }
  const slower = chance !== undefined && chance < SIGNIFICANCE;
  const odds = chance === undefined ? '' : ` (p = ${chance.toFixed(4)})`;
  const over = `over its budget of ${String(reading.budget)}`;
  if (now <= reading.budget) {
    return [
      undefined,
      slower ? `slower than the last release${odds}, within its budget` : undefined,
    ];
  }
  if (chance === undefined || slower) {
    return [slower ? `${over}, and slower than the last release${odds}` : over, undefined];
  }
  return [undefined, `${over}, as the last release was${odds}: noise`];
};

const measuredVerdict = (reading: Reading, before: Reading | undefined): Verdict => {
  const [now, spread] = [median(reading.samples), deviation(reading.samples)];
  const chance =
    before === undefined ? undefined : regressionChance(reading.samples, before.samples);
  const [failure, note] = measuredJudgement(reading, now, chance);
  const ceiling = now + NOISE * spread;
  const tighter =
    failure === undefined && ceiling <= reading.budget * RATCHET ? ceiling : undefined;
  const last = before === undefined ? undefined : median(before.samples);
  return { reading, now, spread, last, chance, failure, note, tighter };
};

/** Each of `now`'s readings judged, against `last`'s of the same name when one machine took both. */
export const audit = (now: Readings, last?: Readings): Verdict[] => {
  const alike = last !== undefined && last.machine === now.machine ? last.readings : [];
  const before = new Map(alike.map((reading) => [reading.name, reading]));
  return now.readings.map((reading) =>
    (reading.counted ? countedVerdict : measuredVerdict)(reading, before.get(reading.name)),
  );
};

const numbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item));

const readingOf = (value: unknown, at: string): Reading => {
  if (
    !isObject(value) ||
    typeof value['name'] !== 'string' ||
    typeof value['unit'] !== 'string' ||
    typeof value['counted'] !== 'boolean' ||
    !Number.isFinite(value['budget']) ||
    !numbers(value['samples'])
  ) {
    throw new Error(`${at} is no reading: a name, a unit, counted, a budget and its samples`);
  }
  const { name, unit, counted, budget, samples } = value;
  return { name, unit, counted, budget: Number(budget), samples };
};

/** `json` as a release's readings, refused whole with what is wrong at `source`. */
export const readingsOf = (json: unknown, source: string): Readings => {
  if (!isObject(json) || typeof json['machine'] !== 'string' || !Array.isArray(json['readings'])) {
    throw new Error(`${source} holds no readings: a machine and a list of readings`);
  }
  const readings = json['readings'].map((value: unknown, index) =>
    readingOf(value, `${source}, reading ${String(index + 1)}`),
  );
  return { machine: json['machine'], readings };
};

/** Six significant figures, as a reading is shown; nothing for no value. */
const shown = (value: number | undefined): string =>
  value === undefined ? '' : String(Number(value.toPrecision(6)));

const rowOf = ({ reading, now, spread, last, chance, failure, note }: Verdict): string[] => [
  reading.name,
  reading.unit,
  reading.counted ? shown(now) : `${shown(now)} ±${shown(spread)}`,
  shown(reading.budget),
  shown(last),
  chance === undefined ? '' : chance.toFixed(4),
  failure ?? (note === undefined ? 'ok' : `ok, ${note}`),
];

/** What the audit prints: a Markdown table of every measure, whether the last release was held
 *  to, and each budget that may tighten. */
export const report = (verdicts: readonly Verdict[], now: Readings, last?: Readings): string[] => [
  ...markdownTable([
    ['measure', 'unit', 'now', 'budget', 'last release', 'p', 'verdict'],
    ...verdicts.map((verdict) => rowOf(verdict)),
  ]),
  ...(last !== undefined && last.machine !== now.machine
    ? [`The last release was measured on ${last.machine}, not ${now.machine}: only budgets held.`]
    : []),
  ...verdicts.flatMap(({ reading, tighter }) =>
    tighter === undefined
      ? []
      : [`${reading.name}: its budget may tighten to ${shown(tighter)} ${reading.unit}`],
  ),
];
