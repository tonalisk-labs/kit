import type { Page } from '@playwright/test';

import { pageScript } from '../checks/in-page.ts';
import { isObject } from '../unknown.ts';
import { ceiling } from './budgets.ts';
import {
  COLLECTOR_KIT,
  collectActivity,
  collectPaint,
  collectResources,
  collectShifts,
  drain,
  type Resource,
  type Shift,
  type Store,
} from './collector.ts';

/** What the page measured since the last read; a metric it never reached is undefined. The
 *  load metrics (TTFB, FCP, LCP) are the current document's, however long ago it loaded. */
export interface Vitals {
  readonly ttfb: number | undefined;
  readonly fcp: number | undefined;
  readonly lcp: number | undefined;
  readonly cls: number;
  /** The nodes that shifted in CLS's window, the largest share first. */
  readonly culprits: readonly string[];
  readonly events: readonly (readonly [number, number])[];
  readonly interactionCount: number | undefined;
  /** Long animation frames, as [duration, blocking duration, start]. */
  readonly longFrames: readonly (readonly [number, number, number])[];
  readonly resources: readonly Resource[];
  /** Which document measured: a navigation changes it. */
  readonly document: string;
}

const KEY = 'sites.testing.vitals';

/** The fewest interactions a percentile is taken over; below it, INP is not a number to trust. */
export const MIN_INTERACTIONS = 20;

/** Interactions per ignored outlier in INP's percentile: the worst of every 50 is dropped. */
const INTERACTIONS_PER_OUTLIER = 50;

/** Installs the collector on every document the page loads from now on. */
export const installVitals = async (page: Page, apiPrefix: string | undefined): Promise<void> => {
  const options = { key: KEY, apiPrefix: apiPrefix ?? '' };
  await page.addInitScript({ content: pageScript(COLLECTOR_KIT, collectPaint, options) });
  await page.addInitScript({ content: pageScript(COLLECTOR_KIT, collectActivity, options) });
  await page.addInitScript(collectResources, options);
  await page.addInitScript(collectShifts, options);
};

const isStore = (value: unknown): value is Store =>
  isObject(value) &&
  typeof value['document'] === 'string' &&
  ['ttfb', 'fcp', 'lcp', 'cls'].every((name) => typeof value[name] === 'number') &&
  ['events', 'frames', 'resources'].every((name) => Array.isArray(value[name]));

const measured = (value: number): number | undefined => (value >= 0 ? value : undefined);

const TOP_CULPRITS = 3;

/** A shift joins the open window under 1 s after its last shift and 5 s after its first. */
const joins = (window: readonly Shift[], [time]: Shift): boolean => {
  const [first] = window[0] ?? [time];
  const [last] = window.at(-1) ?? [time];
  return window.length > 0 && time - last < 1000 && time - first < 5000;
};

/** Where the largest total is, the first of equal ones winning as a stable sort would pick. */
const largestAt = (totals: readonly number[]): number => {
  let best = 0;
  for (const [index, sum] of totals.entries()) {
    best = sum > (totals[best] ?? 0) ? index : best;
  }
  return best;
};

/** CLS's window: the largest run of shifts with gaps under 1 s and a span under 5 s. */
export const clsWindow = (shifts: readonly Shift[]): readonly Shift[] => {
  const windows: Shift[][] = [];
  const totals: number[] = [];
  for (const shift of shifts) {
    const current = windows.at(-1) ?? [];
    if (joins(current, shift)) {
      current.push(shift);
      totals[totals.length - 1] = (totals.at(-1) ?? 0) + shift[1];
    } else {
      windows.push([shift]);
      totals.push(shift[1]);
    }
  }
  return windows[largestAt(totals)] ?? [];
};

/** The nodes CLS's window moved, by the shift values they took part in, with their farthest move. */
const blamed = (shifts: readonly Shift[] = []): string[] => {
  const nodes = new Map<string, { share: number; distance: number; move: string }>();
  for (const [, value, moved] of clsWindow(shifts)) {
    for (const [name, before, after] of moved) {
      const [fromX = 0, fromY = 0] = before;
      const [toX = 0, toY = 0] = after;
      const distance = Math.hypot(toX - fromX, toY - fromY);
      const seen = nodes.get(name) ?? { share: 0, distance: -1, move: '' };
      const move = `${before.join(',')} → ${after.join(',')}`;
      nodes.set(name, {
        share: seen.share + value,
        distance: Math.max(seen.distance, distance),
        move: distance > seen.distance ? move : seen.move,
      });
    }
  }
  return [...nodes]
    .toSorted(([, left], [, right]) => right.share - left.share)
    .slice(0, TOP_CULPRITS)
    .map(([name, { share, move }]) => `${name} (${share.toFixed(3)}; ${move})`);
};

/** Starts the next step's lists afresh, on a document that may have no collector (about:blank). */
export const resetVitals = async (page: Page): Promise<void> => {
  await page.evaluate(drain, KEY);
};

/** Reads what the current document measured, and starts the next step's lists afresh. */
export const readVitals = async (page: Page): Promise<Vitals> => {
  const { store, interactionCount } = await page.evaluate(drain, KEY);
  if (!isStore(store)) {
    throw new Error(`${page.url()} ran without the vitals collector`);
  }
  return {
    ttfb: measured(store.ttfb),
    fcp: measured(store.fcp),
    lcp: measured(store.lcp),
    cls: store.cls,
    culprits: blamed(store.shifts),
    events: store.events,
    interactionCount,
    longFrames: store.frames,
    resources: store.resources,
    document: store.document,
  };
};

/** INP over `performed` interactions: the worst per interaction, dropping one per 50; one under
 *  Event Timing's 16 ms floor has no entry and counts as that fast. */
const inp = (vitals: Vitals, performed: number): number => {
  const worst = new Map<number, number>();
  for (const [id, duration] of vitals.events) {
    worst.set(id, Math.max(worst.get(id) ?? 0, duration));
  }
  const count = Math.max(performed, worst.size, vitals.interactionCount ?? 0);
  if (count < MIN_INTERACTIONS) {
    throw new RangeError(
      `INP needs ${String(MIN_INTERACTIONS)} interactions; ${String(count)} were measured`,
    );
  }
  const durations = [...worst.values()].toSorted((left, right) => right - left);
  return durations[Math.floor(count / INTERACTIONS_PER_OUTLIER)] ?? 0;
};

/** A step's metrics, keyed by the Lighthouse audit id holding their budget; as in timespan mode,
 *  a step without a navigation has no load metrics. */
export const metricsOf = (
  vitals: Vitals,
  interactions: number,
  navigated = true,
): Readonly<Record<string, number>> => {
  const metrics: Record<string, number> = { 'cumulative-layout-shift': vitals.cls };
  const loaded = (value: number | undefined): number | undefined => (navigated ? value : undefined);
  const optional = [
    ['time-to-first-byte', loaded(vitals.ttfb)],
    ['first-contentful-paint', loaded(vitals.fcp)],
    ['largest-contentful-paint', loaded(vitals.lcp)],
    [
      'interaction-to-next-paint',
      interactions >= MIN_INTERACTIONS ? inp(vitals, interactions) : undefined,
    ],
  ] as const;
  for (const [id, value] of optional) {
    if (value !== undefined) {
      metrics[id] = value;
    }
  }
  return metrics;
};

/** Every metric over Google's "good" ceiling, as a failure message; CLS names its culprits. */
export const overBudget = (
  metrics: Readonly<Record<string, number>>,
  culprits: readonly string[] = [],
): string[] =>
  Object.entries(metrics)
    .filter(([id, value]) => value > ceiling(id))
    .map(([id, value]) => {
      const over = `${id} ${value.toFixed(3)} is over its budget of ${String(ceiling(id))}`;
      const named = id === 'cumulative-layout-shift' && culprits.length > 0;
      return named ? `${over}; moved: ${culprits.join(', ')}` : over;
    });

/** The metrics read off the wall clock, which a busy machine stretches, so only reported: the
 *  page's own work is held as its main thread's CPU time (`interaction-cpu`, a step's `cpuMs`). */
export const WALL_CLOCK: ReadonlySet<string> = new Set([
  'time-to-first-byte',
  'first-contentful-paint',
  'largest-contentful-paint',
  'interaction-to-next-paint',
  'total-blocking-time',
  'speed-index',
]);

const picked = (
  metrics: Readonly<Record<string, number>>,
  timed: boolean,
): Record<string, number> =>
  Object.fromEntries(Object.entries(metrics).filter(([id]) => WALL_CLOCK.has(id) === timed));

/** What is held: every metric over its ceiling that no busy machine moves, such as layout shift
 *  and CPU time. */
export const heldOverBudget = (
  metrics: Readonly<Record<string, number>>,
  culprits: readonly string[] = [],
): string[] => overBudget(picked(metrics, false), culprits);

/** What is only reported: the wall-clock metrics over Google's "good". */
export const timedOverBudget = (metrics: Readonly<Record<string, number>>): string[] =>
  overBudget(picked(metrics, true));
