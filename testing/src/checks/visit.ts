import type { Page, Response } from '@playwright/test';

import type { Watch } from '../invariants.ts';
import type { Row } from '../matrix.ts';
import { pageCpuClock } from '../perf/cpu.ts';
import { underReference } from '../perf/profile.ts';
import type { MeasuredStep } from '../perf/steps.ts';
import {
  heldOverBudget,
  metricsOf,
  MIN_INTERACTIONS,
  readVitals,
  timedOverBudget,
} from '../perf/vitals.ts';
import type { Route } from '../routes.ts';
import { axeFindings } from './axe.ts';
import { tabThrough } from './focus.ts';
import { seoFacts, seoProblems } from './seo.ts';
import { illegibleText, LEGIBILITY, overlaps, textLines } from './text.ts';

/** What one visit needs besides the page: its row, its watch, and the target's own checks. */
export interface Visit {
  readonly page: Page;
  readonly row: Row;
  /** The target's origin, where the edge shapes this page's link. */
  readonly origin: string;
  readonly invariants: Watch;
  /** The key that moves focus: WebKit reaches links only with Option held, as Safari does. */
  readonly tabKey: string;
  readonly pageChecks: ((page: Page) => Promise<string[]>) | undefined;
}

/** A 404 page's own load is reported on the console by the browser; that answer is expected. */
const expectedNotFound = (route: Route, problem: string): boolean =>
  route.status === 'not-found' && problem.includes('status of 404') && problem.includes(route.path);

/** Loads the page once the one before may be left: Starlight's search imports Pagefind when
 *  idle, and a page left mid-import has it cut off, which no visitor staying would see. */
const arrive = async (page: Page, invariants: Watch, path: string): Promise<Response | null> => {
  await invariants.scriptsLoaded();
  return page.goto(path);
};

/** The page's problems once its scripts, and what they import, have loaded. */
const problemsOnLeaving = async (invariants: Watch): Promise<string[]> => {
  await invariants.scriptsLoaded();
  return invariants.take();
};

/** Its interactions' main-thread CPU time, in milliseconds per interaction, where the engine
 *  reports one: what the page's own work costs, whatever else the machine does. */
const withCpu = (
  metrics: Readonly<Record<string, number>>,
  cpu: number | undefined,
  presses: number,
): Readonly<Record<string, number>> =>
  cpu === undefined || presses === 0
    ? metrics
    : Object.fromEntries([...Object.entries(metrics), ['interaction-cpu', cpu / presses]]);

/** Layout shift and CPU time over their budgets; the wall-clock vitals, which a busy machine
 *  stretches, are reported. */
const judgeVitals = (
  route: Route,
  metrics: Readonly<Record<string, number>>,
  culprits: readonly string[],
): readonly string[] => {
  for (const line of timedOverBudget(metrics)) {
    console.log(`${route.path}: ${line} (wall clock, reported only)`);
  }
  return heldOverBudget(metrics, culprits);
};

/** What a page gets wrong, by the property: each is read, so one assertion shows them all. */
export type Findings = Readonly<Record<string, readonly unknown[]>>;

/** Tabs through the page as a keyboard does, and answers its vitals with what its interactions
 *  cost in CPU, a throttled row's CPU left out as mostly the throttling's own. */
const interactions = async (
  page: Page,
  { route, row, tabKey }: { route: Route; row: Row; tabKey: Visit['tabKey'] },
): Promise<{ readonly metrics: Readonly<Record<string, number>>; readonly findings: Findings }> => {
  const spent = row.cpu === 'high' ? await pageCpuClock(page) : undefined;
  const reach = await tabThrough(page, tabKey, MIN_INTERACTIONS);
  const cpu = spent === undefined ? undefined : await spent();
  const vitals = await readVitals(page);
  const metrics = withCpu(metricsOf(vitals, reach.presses), cpu, reach.presses);
  const budgets = row.gated ? judgeVitals(route, metrics, vitals.culprits) : [];
  return {
    metrics,
    findings: {
      'Tab reaches every control in <main>': reach.unreached,
      'layout shift and CPU per interaction within budget': budgets,
    },
  };
};

const unmet = (findings: Readonly<Record<string, readonly unknown[]>>): Findings =>
  Object.fromEntries(Object.entries(findings).filter(([, found]) => found.length > 0));

/** Visits one built page once, a gated row under its reference profile as its vitals are gated
 *  there, and answers its measured step and every property it fails. */
export const visit = async (
  route: Route,
  options: Visit,
): Promise<{ readonly step: MeasuredStep; readonly unmet: Findings }> => {
  const { page, row, origin, invariants } = options;
  const response = await underReference({ page, row, origin }, async () =>
    arrive(page, invariants, route.path),
  );
  const status = response === null ? 0 : response.status();
  const answered = route.status === 'ok' ? status < 400 : status === 404;
  const seen: Findings = {
    [`${route.path} answered as it should`]: answered ? [] : [status],
    'SEO basics': seoProblems(await page.evaluate(seoFacts)),
    'legibility floor': await page.evaluate(illegibleText, LEGIBILITY),
    'no overlapping text': overlaps(await textLines(page)),
    'axe-core at its strictest': await axeFindings(page),
    'the target’s own checks':
      options.pageChecks === undefined ? [] : await options.pageChecks(page),
  };
  const { metrics, findings } = await interactions(page, { route, row, tabKey: options.tabKey });
  const problems = await problemsOnLeaving(invariants);
  const invariantsBroken = problems.filter((problem) => !expectedNotFound(route, problem));
  const every: [string, readonly unknown[]][] = [
    ...Object.entries(seen),
    ...Object.entries(findings),
    ['invariants', invariantsBroken],
  ];
  return { step: { name: route.path, metrics }, unmet: unmet(Object.fromEntries(every)) };
};
