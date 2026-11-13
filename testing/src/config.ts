import { globSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import path from 'node:path';

import {
  defineConfig,
  type LaunchOptions,
  type PlaywrightTestConfig,
  type PlaywrightTestProject,
} from '@playwright/test';

import { deviceRowsIn } from './devices.ts';
import { discover, REPO, type Target } from './discover.ts';
import type { Options } from './fixtures.ts';
import { deviceOf, type Row, ROWS, rowName, tierRows } from './matrix.ts';
import { outputOf } from './output.ts';
import { own } from './own.ts';
import { BUDGETS_ENV } from './perf/budgets.ts';
import type { StdoutOptions } from './perf/reporter.ts';
import { LINUX_BROWSERS, MEASURE_ENV } from './stack/control.ts';
import { SLOTS } from './stack/gate-server.ts';
import { BASELINE_ARCH, VISUAL_MOTION } from './visual.ts';

const HERE = import.meta.dirname;

/** Starts the stack host, which owns every service for the whole run. */
const GLOBAL_SETUP = own(import.meta.resolve('./stack/host.ts'));

/** Prints failed assertions' paths and the measured steps: the suite writes only failed output. */
const STDOUT_REPORTER = own(import.meta.resolve('./perf/reporter.ts'));

const PUBLIC_PAGES = own(import.meta.resolve('./public-pages.spec.ts'));
const EDGE_HEADERS = own(import.meta.resolve('./edge-headers.spec.ts'));
const SETUP = own(import.meta.resolve('./stack.setup.ts'));
const TEARDOWN = own(import.meta.resolve('./stack.teardown.ts'));
const CHECKS = own(import.meta.resolve('./config-coverage.check.ts'));

const measuring = (): boolean => process.env[MEASURE_ENV] === '1';

/** A setup builds a target from scratch, a release Rust build included; it may take this long. */
export const SETUP_TIMEOUT_MS = 30 * 60_000;

/** The reporter names slow files, past the setup: its one test builds the target, which no split
 *  across workers shortens. Playwright's own report, which can't leave it out, names none. */
const REPORTING = {
  reporter: [['list'], [STDOUT_REPORTER, { setupFile: SETUP } satisfies StdoutOptions]],
  reportSlowTests: { max: 0, threshold: Number.POSITIVE_INFINITY },
} satisfies Pick<PlaywrightTestConfig, 'reporter' | 'reportSlowTests'>;

/** A run's workers: the machine's slots, so a run alone fills them; a measured run holds two,
 *  whatever the host, so its figures stay comparable. */
export const hostWorkers = (): number => (measuring() ? 2 : SLOTS);

type TargetProject = PlaywrightTestProject<object, Options>;

/** Firefox's bounce-tracking timer, started as a response arrives: a load slower than it, on a
 *  throttled row or a busy machine, gets the site's own host flagged as a bounce tracker. */
export const CLIENT_BOUNCE_TIMER =
  'privacy.bounceTrackingProtection.clientBounceDetectionTimerPeriodMS';

/** An engine's launch options past Playwright's: Firefox's bounce timer as long as a run may take,
 *  so a slow load is never a bounce, while a real hop is still caught as its navigation ends. */
export const launchOf = (engine: Row['engine']): LaunchOptions =>
  engine === 'firefox' ? { firefoxUserPrefs: { [CLIENT_BOUNCE_TIMER]: SETUP_TIMEOUT_MS } } : {};

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const optionsOf = (target: Target, row: Row): NonNullable<TargetProject['use']> => {
  const device = deviceOf(row);
  const options: NonNullable<TargetProject['use']> = {
    browserName: row.engine,
    site: target.name,
    row,
    viewport: device.viewport,
    userAgent: device.userAgent,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    launchOptions: launchOf(row.engine),
  };
  // A screen class's own screen, which the table's descriptors leave to Playwright.
  return device.screen === undefined
    ? options
    : Object.assign(options, { contextOptions: { screen: device.screen } });
};

/** Every row's zone and language, whatever the machine's; a spec may still set its own. The
 *  visual projects keep the ones their baselines were drawn in. */
const ENVIRONMENT = { timezoneId: 'Europe/Lisbon', locale: 'en-GB' } as const;

const lifecycle = (key: string): TargetProject[] => [
  {
    name: `${key}/setup`,
    testDir: HERE,
    testMatch: SETUP,
    teardown: `${key}/teardown`,
    timeout: SETUP_TIMEOUT_MS,
    use: { site: key },
  },
  { name: `${key}/teardown`, testDir: HERE, testMatch: TEARDOWN, use: { site: key } },
];

/** A target's guard specs: `tests/guard/`, run once against its stack alongside the rows: a
 *  worker error in a later dependency phase would drop every project that waits for them. */
const GUARD = path.join('tests', 'guard');

/** A target's measured journeys: `tests/measure/`, run alone and only when asked for. */
const MEASURE = path.join('tests', 'measure');

const guardProjects = (target: Target): TargetProject[] =>
  globSync(path.join(GUARD, '**', '*.spec.ts'), { cwd: target.root }).length === 0
    ? []
    : [
        {
          name: `${target.name}/guard`,
          testDir: path.join(target.root, GUARD),
          testMatch: '**/*.spec.ts',
          dependencies: [`${target.name}/setup`],
          use: { site: target.name },
        },
      ];

interface RowContext {
  readonly others: readonly string[];
}

/** A test that owns its target's stack alone (fixtures), such as a backend restart. */
const EXCLUSIVE = /@exclusive(?:\s|$)/u;

const tagged = (name: string): RegExp => new RegExp(`@${escaped(name)}(?:\\s|$)`, 'u');

/** A test that makes no page (fixtures' `apiTest`): run once per target, not on every row. */
const API = /@api(?:\s|$)/u;

/** An API test that also owns its stack alone. */
const API_EXCLUSIVE = /^(?=.*@api(?:\s|$))(?=.*@exclusive(?:\s|$))/u;

/** A row's specs, its target's tests or its measured journeys, from the narrowest folder holding
 *  them, so the search never walks build output that another task of a check may be rewriting. */
const rowBase = (target: Target, row: Row, context: RowContext): TargetProject => ({
  name: `${target.name}/${rowName(row)}`,
  testDir: path.join(target.root, measuring() ? MEASURE : 'tests'),
  testMatch: '**/*.spec.ts',
  testIgnore: [
    path.join(target.root, GUARD, '**'),
    ...(measuring() ? [] : [path.join(target.root, MEASURE, '**')]),
  ],
  grepInvert: [...context.others.map((other) => tagged(other)), API],
  dependencies: [`${target.name}/setup`, ...(inLinux(row) ? [`${LINUX_BROWSERS}/setup`] : [])],
  use: Object.assign(optionsOf(target, row), ENVIRONMENT),
});

const rowProject = (target: Target, row: Row, context: RowContext): TargetProject =>
  Object.assign(rowBase(target, row, context), {
    grepInvert: [...context.others.map((other) => tagged(other)), API, EXCLUSIVE],
  });

/** A row's run of the shared public pages spec. It has a project of its own, rooted in this
 *  package, since Playwright collects no test file under node_modules. */
const pagesProject = (target: Target, row: Row, context: RowContext): TargetProject =>
  Object.assign(rowProject(target, row, context), {
    name: `${target.name}/${rowName(row)}/pages`,
    testDir: HERE,
    testMatch: PUBLIC_PAGES,
    testIgnore: [],
  });

/** A target's API tests, once against its stack: no browser, so no row. */
const apiBase = (target: Target, name: string): TargetProject => ({
  name,
  testDir: path.join(target.root, 'tests'),
  testMatch: '**/*.spec.ts',
  testIgnore: [path.join(target.root, GUARD, '**'), path.join(target.root, MEASURE, '**')],
  dependencies: [`${target.name}/setup`],
  use: { site: target.name },
});

/** A target with an adapter: its answers held to the headers its production edge adds, once. */
const edgeHeadersProjects = (target: Target): TargetProject[] =>
  target.adapter === undefined || measuring()
    ? []
    : [
        {
          name: `${target.name}/edge-headers`,
          testDir: HERE,
          testMatch: EDGE_HEADERS,
          dependencies: [`${target.name}/setup`],
          use: { site: target.name },
        },
      ];

/** The shared API tests, and separately the `@exclusive` ones, queued with the rows' own. */
const apiProjects = (
  target: Target,
): { readonly shared: TargetProject[]; readonly exclusive: TargetProject[] } =>
  measuring()
    ? { shared: [], exclusive: [] }
    : {
        shared: [
          Object.assign(apiBase(target, `${target.name}/api`), {
            grep: API,
            grepInvert: EXCLUSIVE,
          }),
        ],
        exclusive: [
          Object.assign(apiBase(target, `${target.name}/api/exclusive`), {
            grep: API_EXCLUSIVE,
          }),
        ],
      };

/**
 * A row's `@exclusive` tests, queued after every row's shared ones: an owner waiting midway
 * holds every other test of its target until the longest running one ends (a minute or more).
 */
const exclusiveProject = (target: Target, row: Row, context: RowContext): TargetProject =>
  Object.assign(rowBase(target, row, context), {
    name: `${target.name}/${rowName(row)}/exclusive`,
    grep: EXCLUSIVE,
  });

/** On macOS, WebKit runs in Playwright's Linux image: its native build prompts for the keychain. */
const inLinux = (row: Row): boolean => row.engine === 'webkit' && platform() === 'darwin';

/** A target's projects: setup and teardown of its services, its guard and API tests, and per row
 *  its specs, the shared public pages (tagged by target, the others' left out) and `@exclusive`. */
const targetProjects = (
  target: Target,
  others: readonly string[],
  rows: readonly Row[],
): { readonly shared: TargetProject[]; readonly exclusive: TargetProject[] } => {
  const guard = guardProjects(target);
  const context = { others };
  const api = apiProjects(target);
  return {
    shared: [
      ...lifecycle(target.name),
      ...guard,
      ...edgeHeadersProjects(target),
      ...api.shared,
      ...rows.flatMap((row) => [
        rowProject(target, row, context),
        pagesProject(target, row, context),
      ]),
    ],
    exclusive: [...api.exclusive, ...rows.map((row) => exclusiveProject(target, row, context))],
  };
};

/** The rows whose screens hold committed baselines: the desktop and the phone. */
const VISUAL_ROWS: ReadonlySet<number> = new Set([1, 13]);

const VISUAL_TAG = 'visual';

export const hasVisual = (target: Pick<Target, 'root'>): boolean =>
  globSync(path.join('tests', '**', '*.spec.ts'), { cwd: target.root }).some((file) =>
    readFileSync(path.join(target.root, file), 'utf8').includes(`@${VISUAL_TAG}`),
  );

/**
 * Whether a run holds screens to their baselines: the full matrix, unmeasured. CI checks them only
 * on the architecture that drew them (its arm64 runner); a workstation of another is told why.
 */
export const runsVisual = (tier: string | undefined, machine: string = arch()): boolean =>
  tier !== 'smoke' &&
  tier !== 'dev' &&
  !measuring() &&
  (process.env['CI'] === undefined || machine === BASELINE_ARCH);

/** A visual project's options: the row's device, with motion reduced (`VISUAL_MOTION`). */
export const visualUseOf = (target: Target, row: Row): NonNullable<TargetProject['use']> => {
  const options = optionsOf(target, row);
  const contextOptions = Object.assign(structuredClone(options.contextOptions ?? {}), {
    reducedMotion: VISUAL_MOTION,
  });
  return Object.assign(options, { visual: true, contextOptions });
};

/** Visual checks, where `runsVisual` says: rows 1 and 13 run `@visual` tests on Chromium in the
 *  Linux image WebKit uses, against `tests/__screenshots__/<spec>/arm64/<form>/`. */
const visualProjects = (tier: string | undefined, targets: readonly Target[]): TargetProject[] => {
  if (!runsVisual(tier)) {
    return [];
  }
  const rows = ROWS.filter(({ number }) => VISUAL_ROWS.has(number));
  return targets
    .filter((target) => hasVisual(target))
    .flatMap((target) =>
      rows.map((row): TargetProject => ({
        name: `${target.name}/visual-${String(row.number).padStart(2, '0')}`,
        testDir: path.join(target.root, 'tests'),
        testMatch: '**/*.spec.ts',
        testIgnore: [path.join(target.root, GUARD, '**'), path.join(target.root, MEASURE, '**')],
        grep: tagged(VISUAL_TAG),
        snapshotPathTemplate: `{testDir}/__screenshots__/{testFilePath}/${BASELINE_ARCH}/{arg}{ext}`,
        workers: 1,
        dependencies: [`${target.name}/setup`, `${LINUX_BROWSERS}/setup`],
        use: visualUseOf(target, row),
      })),
    );
};

/** Every project, target by row, of the tier `E2E_TIER` names, all rows when unset; a measured run
 *  keeps to the table its budgets name. Shared tests run before the `@exclusive` ones. */
const projects = (tier = process.env['E2E_TIER']): TargetProject[] => {
  const targets = discover();
  const names = targets.map(({ name }) => name);
  const rows = tierRows(tier, measuring() ? [] : deviceRowsIn(REPO, ROWS.length + 1));
  const harness: TargetProject = { name: 'harness', testDir: HERE, testMatch: CHECKS };
  const visual = visualProjects(tier, targets);
  const built = targets.map((target) =>
    targetProjects(
      target,
      names.filter((name) => name !== target.name),
      rows,
    ),
  );
  return [
    harness,
    ...(rows.some((row) => inLinux(row)) || visual.length > 0 ? lifecycle(LINUX_BROWSERS) : []),
    ...built.flatMap(({ shared }) => shared),
    ...built.flatMap(({ exclusive }) => exclusive),
    ...visual,
  ];
};

/** What a repo's config may name: its budgets file from its root, when not `perf-budgets.json`. */
export interface TestsOptions {
  readonly budgets?: string;
}

/** Each test's backstop, for one that keeps moving for ever, as its watch ends one standing still
 *  (stuck.ts): over 2.5 times the slowest seen under load, a 21-minute journal chapter on 3G. */
const TEST_TIMEOUT_MS = 60 * 60_000;

/** A repo's whole Playwright config, `export default defineTests()`: each site and app crossed with
 *  the matrix rows. Every process of the run loads it, so each reads the budgets file named. */
export const defineTests = ({ budgets }: TestsOptions = {}): PlaywrightTestConfig<
  object,
  Options
> => {
  if (budgets !== undefined) {
    process.env[BUDGETS_ENV] = budgets;
  }
  const output = outputOf(REPO);
  return defineConfig<object, Options>({
    timeout: TEST_TIMEOUT_MS,
    fullyParallel: true,
    forbidOnly: true,
    retries: 0,
    workers: hostWorkers(),
    reporter: REPORTING.reporter,
    reportSlowTests: REPORTING.reportSlowTests,
    outputDir: output.outputDir,
    preserveOutput: output.preserveOutput,
    globalSetup: GLOBAL_SETUP,
    updateSnapshots: 'none',
    expect: {
      toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 },
    },
    use: { trace: 'off', video: 'off', screenshot: 'off' },
    projects: projects(),
  });
};
