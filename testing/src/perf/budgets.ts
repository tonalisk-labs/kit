import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import KIT_BUDGETS from '../../perf-budgets.json' with { type: 'json' };
import { REPO } from '../discover.ts';
import { isObject } from '../unknown.ts';

type Ceilings = Readonly<Record<string, number>>;

/** `counted` holds on every row, and `timed` is keyed by row number. */
export interface JourneyBudget {
  readonly counted: Ceilings;
  readonly timed: Readonly<Record<string, Ceilings>>;
}

const isPerRow = (value: unknown): boolean =>
  isObject(value) && Object.values(value).every((ceilings) => isCeilings(ceilings));

/** A known breach of Google's "good", listed until its fix lands. `row` is the row's number. */
export interface KnownFinding {
  readonly target: string;
  readonly step: string;
  readonly row: string;
  readonly metric: string;
}

/** The key under `journeys` for the known findings. Every other key is a target. */
const KNOWN = 'known';

/** `minScore` is each Lighthouse category's minimum unless `minScores` names its own; `journeys`
 *  holds each target's step budgets, and the known findings. */
interface Budgets {
  readonly minScore: number;
  readonly minScores: Ceilings;
  /** The size budget (kit-size) every site starts from, in brotli bytes; `sizes` sets a site's own. */
  readonly size: Ceilings;
  readonly sizes?: Readonly<Record<string, Ceilings>>;
  readonly max: Ceilings;
  readonly journeys?: Readonly<Record<string, unknown>>;
}

const isCeilings = (value: unknown): value is Ceilings =>
  isObject(value) && Object.values(value).every((ceiling) => typeof ceiling === 'number');

const isJourneyBudget = (value: unknown): value is JourneyBudget =>
  isObject(value) && isCeilings(value['counted']) && isPerRow(value['timed']);

const isSteps = (value: unknown): value is Readonly<Record<string, JourneyBudget>> =>
  isObject(value) && Object.values(value).every((budget) => isJourneyBudget(budget));

const isKnownFinding = (value: unknown): value is KnownFinding =>
  isObject(value) &&
  ['target', 'step', 'row', 'metric'].every((name) => typeof value[name] === 'string');

const isKnown = (value: unknown): value is readonly KnownFinding[] =>
  Array.isArray(value) && value.every((finding) => isKnownFinding(finding));

const isJourneys = (value: unknown): boolean =>
  value === undefined ||
  (isObject(value) &&
    Object.entries(value).every(([key, entry]) =>
      key === KNOWN ? isKnown(entry) : isSteps(entry),
    ));

const isBudgets = (value: unknown): value is Budgets =>
  isObject(value) &&
  typeof value['minScore'] === 'number' &&
  isCeilings(value['minScores']) &&
  isCeilings(value['size']) &&
  isCeilings(value['max']) &&
  isJourneys(value['journeys']);

/** An optional entry: absent, or one `check` holds. */
const absentOr = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  value === undefined || check(value);

const isSiteSizes = (value: unknown): boolean =>
  isObject(value) && Object.values(value).every((site) => isCeilings(site));

/** A repo's own budgets: any of kit's, and its journeys. */
const isOwnBudgets = (value: unknown): value is Partial<Budgets> =>
  isObject(value) &&
  absentOr(value['minScore'], (score) => typeof score === 'number') &&
  absentOr(value['minScores'], isCeilings) &&
  absentOr(value['sizes'], isSiteSizes) &&
  absentOr(value['max'], isCeilings) &&
  isJourneys(value['journeys']);

/** `base`, each of whose entries `over` names replaced by its own. */
const overlaid = (base: Ceilings, over: Ceilings = {}): Ceilings =>
  Object.fromEntries([...Object.entries(base), ...Object.entries(over)]);

const parse = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** The variable naming the repo's budgets file from its root, such as `spec/budgets.json`;
 *  `perf-budgets.json` when unset. */
export const BUDGETS_ENV = 'KIT_BUDGETS';

/** The repo's budgets file. */
export const budgetsFile = (): string =>
  path.resolve(REPO, process.env[BUDGETS_ENV] ?? 'perf-budgets.json');

/** The defaults, under the repo's own budgets where it has them. */
const load = (): Budgets => {
  // Google's "good", which kit ships.
  const defaults: unknown = KIT_BUDGETS;
  if (!isBudgets(defaults)) {
    throw new TypeError("kit's perf-budgets.json does not hold { minScore, minScores, size, max }");
  }
  const file = budgetsFile();
  if (!existsSync(file)) {
    return defaults;
  }
  const own = parse(file);
  if (!isOwnBudgets(own)) {
    throw new TypeError(`${file} does not hold { minScore?, minScores?, sizes?, max?, journeys? }`);
  }
  const minScore = own.minScore ?? defaults.minScore;
  const minScores = overlaid(defaults.minScores, own.minScores);
  const max = overlaid(defaults.max, own.max);
  const budgets = { minScore, minScores, size: defaults.size, max };
  return Object.assign(
    budgets,
    own.sizes === undefined ? {} : { sizes: own.sizes },
    own.journeys === undefined ? {} : { journeys: own.journeys },
  );
};

/** Loaded once, on first use, so the file a repo names is read in every process. */
const loaded: { budgets?: Budgets } = {};
const budgets = (): Budgets => {
  loaded.budgets ??= load();
  return loaded.budgets;
};

/** The score a Lighthouse category must reach, out of 100. Accessibility, best practices and SEO
 *  have nothing to trade against, so kit holds them at 100. */
export const minimumScore = (category: string): number => {
  const { minScores, minScore } = budgets();
  return minScores[category] ?? minScore;
};

/** A site's size budget (kit-size), in brotli bytes: kit's, under what the repo sets for the site. */
export const sizeBudget = (site: string): Ceilings => {
  const { size, sizes } = budgets();
  return overlaid(size, sizes === undefined ? undefined : sizes[site]);
};

/** By Lighthouse audit id. A missing ceiling means a broken budget file. */
export const ceiling = (id: string): number => {
  const max = budgets().max[id];
  if (max === undefined) {
    throw new Error(`${path.relative(REPO, budgetsFile())} has no ceiling for ${id}`);
  }
  return max;
};

/** A journey step's budget, or undefined until one is set from its baseline. */
export const journeyBudget = (target: string, step: string): JourneyBudget | undefined => {
  const { journeys } = budgets();
  const steps: unknown = journeys === undefined || target === KNOWN ? undefined : journeys[target];
  return isSteps(steps) ? steps[step] : undefined;
};

export const knownFindings = (): readonly KnownFinding[] => {
  const { journeys } = budgets();
  const known: unknown = journeys === undefined ? undefined : journeys[KNOWN];
  return isKnown(known) ? known : [];
};
