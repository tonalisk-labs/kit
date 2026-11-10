// Tests Playwright never ran, by project and with the reason, so no run skips one in silence: a
// project waits on its dependencies, and Playwright counts none as passed once a worker errored.
import type { TestCase, TestResult } from '@playwright/test/reporter';

/** What "did not run" reads of a test. */
interface Ran {
  readonly outcome: () => ReturnType<TestCase['outcome']>;
  readonly results: readonly Pick<TestResult, 'status'>[];
  readonly expectedStatus: TestCase['expectedStatus'];
}

export interface ProjectTally {
  readonly dependencies: readonly string[];
  /** Tests that ran and did not end as expected. */
  readonly failed: number;
  /** Tests Playwright never ran, as its summary's "did not run" counts them. */
  readonly unrun: number;
}

/** Playwright's own "did not run": skipped, not interrupted, and never run or not meant to skip. */
export const didNotRun = (test: Ran): boolean =>
  test.outcome() === 'skipped' &&
  !test.results.some(({ status }) => status === 'interrupted') &&
  (test.results.length === 0 || test.expectedStatus !== 'skipped');

const plural = (count: number, one: string): string =>
  `${String(count)} ${one}${count === 1 ? '' : 's'}`;

const reasonOf = (
  tally: ProjectTally,
  projects: ReadonlyMap<string, ProjectTally>,
  workerErrors: readonly string[],
): string => {
  const of = (name: string): ProjectTally =>
    projects.get(name) ?? { dependencies: [], failed: 0, unrun: 0 };
  const failed = tally.dependencies.filter((name) => of(name).failed > 0);
  if (failed.length > 0) {
    return `its dependency ${failed.join(', ')} failed`;
  }
  const unrun = tally.dependencies.filter((name) => of(name).unrun > 0);
  if (unrun.length > 0) {
    return `its dependency ${unrun.join(', ')} did not run`;
  }
  if (tally.failed > 0) {
    return 'a test of its own failed first (a serial group or --max-failures)';
  }
  const [error] = workerErrors;
  if (error !== undefined) {
    return `its dependencies passed, but after a worker error Playwright counts no dependency as passed: ${error}`;
  }
  return 'its dependencies passed, yet Playwright queued none of its tests';
};

export const unrunReport = (
  projects: ReadonlyMap<string, ProjectTally>,
  workerErrors: readonly string[],
): string[] => {
  const unrun = [...projects].filter(([, { unrun: count }]) => count > 0);
  if (unrun.length === 0) {
    return [];
  }
  const total = unrun.reduce((sum, [, { unrun: count }]) => sum + count, 0);
  return [
    `Did not run: ${plural(total, 'test')} in ${plural(unrun.length, 'project')}, which fails the run.`,
    ...unrun.map(
      ([name, tally]) =>
        `  ${name}: ${plural(tally.unrun, 'test')}; ${reasonOf(tally, projects, workerErrors)}`,
    ),
  ];
};

/** A runner's error that Playwright raises for a worker process, with the worker's index. */
const WORKER_ERROR = /\bworker-(?<index>\d+) process\b/u;

export const workerNamed = (message: string): number | undefined => {
  const { groups = {} } = WORKER_ERROR.exec(message) ?? {};
  const { index } = groups;
  return index === undefined ? undefined : Number(index);
};
