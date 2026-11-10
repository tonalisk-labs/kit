// Every built page of every target, visited once, with every property checked in that visit.
import { expect, type TestInfo } from '@playwright/test';

import { loadAdapter } from './adapter.ts';
import { type Visit, visit } from './checks/visit.ts';
import { discover, type Target } from './discover.ts';
import { test } from './fixtures.ts';
import { attachSteps } from './perf/steps.ts';
import { routesOf } from './routes.ts';

/** The pages are dealt out over this many tests, which run in parallel: fixed, so the test list
 *  is the same on every machine. */
const SHARES = 4;

/** Per page, the most a visit takes: the checks, axe-core, and the tab order twice. */
const PAGE_TIMEOUT_MS = 60_000;

/** WebKit, like Safari, moves focus to links only with Option held. */
const TAB_KEYS: Readonly<Record<string, string>> = { webkit: 'Alt+Tab' };

const inSequence = async <Item, Result>(
  items: readonly Item[],
  action: (item: Item) => Promise<Result>,
  results: Result[] = [],
): Promise<Result[]> => {
  const item = items[results.length];
  if (item === undefined) {
    return results;
  }
  results.push(await action(item));
  return inSequence(items, action, results);
};

/** Each build's routes, globbed once per worker however many shares it runs. */
const routesByDir = new Map<string, ReturnType<typeof routesOf>>();
const builtRoutes = (dir: string): ReturnType<typeof routesOf> => {
  const routes = routesByDir.get(dir) ?? routesOf(dir);
  routesByDir.set(dir, routes);
  return routes;
};

interface Sweep {
  readonly target: Target;
  /** The build the stack serves, whose pages are visited. */
  readonly siteDir: string;
  readonly share: number;
  readonly visit: Visit;
}

const sweep = async (options: Sweep, testInfo: TestInfo): Promise<void> => {
  const routes = builtRoutes(options.siteDir).filter(
    (_route, index) => index % SHARES === options.share - 1,
  );
  test.skip(routes.length === 0, 'the build has fewer pages than shares');
  testInfo.setTimeout(routes.length * PAGE_TIMEOUT_MS);
  const visits = await inSequence(routes, async (route) =>
    test.step(`${route.path} holds every property`, async () => visit(route, options.visit)),
  );
  await attachSteps(testInfo, {
    target: options.target.name,
    steps: visits.map(({ step }) => step),
  });
  // Every page is visited first, so the share shows all its pages get wrong in one assertion.
  const failing = visits.filter(({ unmet }) => Object.keys(unmet).length > 0);
  expect(Object.fromEntries(failing.map(({ step, unmet }) => [step.name, unmet]))).toEqual({});
};

for (const target of discover()) {
  test.describe(target.name, { tag: `@${target.name}` }, () => {
    for (const share of Array.from({ length: SHARES }, (_share, index) => index + 1)) {
      test(`every built page in share ${String(share)} of ${String(SHARES)} holds its properties`, async ({
        page,
        row,
        stack,
        baseURL,
        browserName,
        invariants,
      }, testInfo) => {
        if (row === undefined || baseURL === undefined) {
          throw new Error('the public pages run on a matrix row, against a target origin');
        }
        const adapter = await loadAdapter(target.adapter);
        await sweep(
          {
            target,
            siteDir: stack.siteDir,
            share,
            visit: {
              page,
              row,
              origin: new URL(baseURL).origin,
              invariants,
              tabKey: TAB_KEYS[browserName] ?? 'Tab',
              pageChecks: adapter === undefined ? undefined : adapter.pageChecks,
            },
          },
          testInfo,
        );
      });
    }
  });
}
