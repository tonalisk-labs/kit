import { arch, platform } from 'node:os';

import {
  test as base,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo,
  type TestType,
} from '@playwright/test';

import { browserWatch, REPORT_WAIT_MS } from './browser-crash.ts';
import { joinEdge } from './edge-client.ts';
import { type Watch, watch } from './invariants.ts';
import type { Row } from './matrix.ts';
import { CPU_SLOWDOWN } from './network.ts';
import { type Meter, type Reconnect, startMeter } from './perf/measure.ts';
import { FAILURE_ATTACHMENT } from './perf/steps.ts';
import { installVitals } from './perf/vitals.ts';
import { deviceBudget, endpointOf } from './stack/browsers.ts';
import {
  holdBrowserSeat,
  holdStack,
  deadlineFrom,
  holdTestTurn,
  testBegins,
  waitedFor,
  HOST_ENV,
  LINUX_ENV,
  MEASURE_ENV,
  STACK_ENV,
} from './stack/control.ts';
import { announceDeadline } from './stack/hold.ts';
import { claimPort } from './stack/ports.ts';
import type { Coordinates } from './stack/stack.ts';
import { browserTrust, trustCa } from './stack/tls.ts';
import { endStuck, hearProgress, type Progress, stuckProblem, watchProgress } from './stuck.ts';
import { BASELINE_ARCH, VISUAL_MOTION } from './visual.ts';

/** The options every target project sets: its target, and the matrix row it runs on. */
export interface Options {
  readonly site: string;
  readonly row: Row | undefined;
  /** A visual project's: Chromium in the Linux image, holding screens to their baselines. */
  readonly visual: boolean;
  /** The most browser contexts one of the worker's tests has open at once, its own included: a
   *  seat each in the Linux image while the test runs, which a test of several devices declares
   *  with `test.use`. */
  readonly browserContexts: number;
}

/** The tag of a test that disturbs its whole stack, such as a backend restart. */
const EXCLUSIVE = '@exclusive';

/** The tag of a test that makes no page (`apiTest`): run once per target, not on every row. */
const API = '@api';

interface StackWorkerFixtures {
  /** The target's running stack, from its setup project. */
  readonly stack: Coordinates;
}

interface StackFixtures {
  /** Whether this test owns the stack alone (`@exclusive`), or shares it with every other. */
  readonly stackHold: boolean;
  /** The test's deadline following its timeout to the servers of its holds. */
  readonly deadlines: boolean;
  /** The test's watch for standing still (stuck.ts), from its last hold on. */
  readonly progress: Progress;
}

/** Runs a test under its watch: should it stand still, it ends through its own timeout, and its
 *  teardown says what stood still. Holds' waits come before it, as they are not the test's. */
const watchedTest = async (
  provide: (progress: Progress) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> => {
  const began = performance.now();
  const stood: { last?: string } = {};
  const progress = watchProgress({
    stuck: (last) => {
      stood.last = last;
      endStuck(testInfo, performance.now() - began);
    },
  });
  try {
    await provide(progress);
  } finally {
    progress.stop();
  }
  if (stood.last !== undefined) {
    throw stuckProblem(stood.last);
  }
};

/** The last move of a deadline on its way, so the next follows it and the servers hear them in
 *  the order the test made them. */
const announcing = { last: Promise.resolve(true) };

/** Tells the servers of the running test's holds its deadline, as its timeout now stands; a server
 *  that can't be told keeps the deadline it had. */
const announceTimeout = (timeout: number): void => {
  const deadline = deadlineFrom(timeout);
  announcing.last = announcing.last.then(async () =>
    announceDeadline(deadline).then(
      () => true,
      () => false,
    ),
  );
};

/** `type.slow()` moves the running test's deadline with its timeout, as `testInfo.slow()` does: it
 *  triples the timeout without `setTimeout`, so a hold's deadline would stay a third of it. */
const followingSlow = <Type extends object>(type: Type): Type => {
  const slow: unknown = Reflect.get(type, 'slow');
  if (typeof slow === 'function') {
    Reflect.set(type, 'slow', (...args: unknown[]): void => {
      Reflect.apply(slow, type, args);
      try {
        announceTimeout(base.info().timeout);
      } catch {
        // Called while the file loads, for every test in it: no test runs, so none holds anything.
      }
    });
  }
  return type;
};

interface WorkerFixtures {
  /** Chromium's DevTools port, which Lighthouse connects to; no other engine has one. */
  readonly cdpPort: number | undefined;
}

/** Further devices of a test, each a context of its own the test's end closes, pass or fail. */
export interface Devices {
  readonly newDevice: (options?: BrowserContextOptions) => Promise<Page>;
}

interface TestFixtures {
  /** Whether the test holds seats in the Linux image (stack/browsers.ts), one per context it may
   *  have open. */
  readonly browserSeat: boolean;
  /** The test's CPU turn, held for its own work. */
  readonly cpuTurn: boolean;
  readonly invariants: Watch;
  readonly devices: Devices;
  /** Live sockets' channels by path, for a metered page's frame counts. */
  readonly channels: Readonly<Record<string, RegExp>>;
  /** How the target's app reconnects a dropped socket, for a metered page's reconnect split. */
  readonly reconnect: Reconnect | undefined;
  /** In a `--measure` run, the page metered for `measureStep`: its stamps, and its context's
   *  traffic by step. */
  readonly meter: Meter | undefined;
  /** A keyboard-only test (`test.use({ keyboardOnly: true })`): it fails on any pointer press,
   *  touch or wheel turn its page hears, so it reaches what it reaches by keys alone. */
  readonly keyboardOnly: boolean;
  /** When the watch on the worker's browser began (ms since the epoch): a browser lost before the
   *  test ends fails it as its engine's crash. */
  readonly browserCrash: number;
}

/** How many times slower the row runs the page's CPU: on Chromium's low tier alone. */
const slowdownOf = (row: Row | undefined, browserName: string): number =>
  browserName === 'chromium' && row !== undefined ? CPU_SLOWDOWN[row.cpu] : 1;

/** What a failed test's page showed, for the stdout reporter: the suite writes no files. */
const failureReport = (page: Page, problems: readonly string[], api: readonly string[]): string =>
  [
    `  at ${page.isClosed() ? 'a closed page' : page.url()}`,
    ...problems.map((problem) => `  ${problem}`),
    ...(api.length === 0 ? [] : ['  last API calls:', ...api.map((line) => `    ${line}`)]),
  ].join('\n');

const isCoordinates = (value: unknown): value is Coordinates =>
  typeof value === 'object' &&
  value !== null &&
  'baseURL' in value &&
  typeof value.baseURL === 'string';

/** Playwright's own fixtures, named so the declarations point at @playwright/test. */
type BaseTest = PlaywrightTestArgs & PlaywrightTestOptions;
type BaseWorker = PlaywrightWorkerArgs & PlaywrightWorkerOptions;

/**
 * A test of the target's API alone, tagged `@api`: it has the stack and its hold, and no browser,
 * page or page invariants; the harness runs it once per target (config.ts), not on every row.
 */
export const apiTest: TestType<
  BaseTest & StackFixtures,
  BaseWorker & Options & StackWorkerFixtures
> = followingSlow(
  base.extend<StackFixtures, Options & StackWorkerFixtures>({
    /** A test sets its timeout as it starts, past the holds its fixtures took, or makes itself slow:
     *  each change moves the deadline its holds' servers bound their waits by (stack/stall.ts). */
    deadlines: [
      async ({ site: _site }, provide, testInfo): Promise<void> => {
        testBegins();
        const set = testInfo.setTimeout.bind(testInfo);
        const slow = testInfo.slow.bind(testInfo);
        Object.assign(testInfo, {
          setTimeout: (timeout: number): void => {
            set(timeout);
            announceTimeout(testInfo.timeout);
          },
          slow: (...args: Parameters<typeof slow>): void => {
            slow(...args);
            announceTimeout(testInfo.timeout);
          },
        });
        await provide(true);
      },
      { auto: true },
    ],
    site: ['', { option: true, scope: 'worker' }],
    browserContexts: [1, { option: true, scope: 'worker' }],
    row: [undefined, { option: true, scope: 'worker' }],
    visual: [false, { option: true, scope: 'worker' }],
    stack: [
      async ({ site }, provide): Promise<void> => {
        const handoff = process.env[STACK_ENV];
        const parsed: unknown = handoff === undefined ? undefined : JSON.parse(handoff);
        if (!isCoordinates(parsed)) {
          throw new Error(`${site} has no running stack: its setup project starts one`);
        }
        // Node's own clients (fetch, WebSocket) reach the edge over TLS too.
        trustCa(parsed.trust.ca);
        await provide(parsed);
      },
      { scope: 'worker' },
    ],
    stackHold: [
      async ({ site }, provide, testInfo): Promise<void> => {
        const owns = testInfo.tags.includes(EXCLUSIVE);
        if (site === '' || process.env[HOST_ENV] === undefined) {
          await provide(owns);
          return;
        }
        const release = await waitedFor(async () => holdStack(owns ? 'own' : 'share', site));
        announceTimeout(testInfo.timeout);
        try {
          await provide(owns);
        } finally {
          release();
        }
      },
      // Unbounded, and out of the test's own time: the grant always comes, as each holder is a test
      // under its own timeout, whose end gives the hold back.
      { auto: true, timeout: 0 },
    ],
    progress: [
      async ({ stackHold: _held }, provide, testInfo): Promise<void> => {
        await watchedTest(provide, testInfo);
      },
      { auto: true },
    ],
  }),
);

/** A browser the Linux image's server runs, where the stack host started one. */
const servedByImage = (browserName: string, visual: boolean): boolean =>
  (visual || browserName === 'webkit') && process.env[LINUX_ENV] !== undefined;

/** A test on a matrix row: its browser, its page and the invariants every page holds. */
export const test: TestType<
  BaseTest & StackFixtures & TestFixtures,
  BaseWorker & Options & StackWorkerFixtures & WorkerFixtures
> = followingSlow(
  apiTest.extend<TestFixtures, WorkerFixtures>({
    cdpPort: [
      async ({ browserName, visual }, provide): Promise<void> => {
        // The visual projects' Chromium runs in the container, its DevTools port out of reach.
        const claim = browserName === 'chromium' && !visual ? await claimPort() : undefined;
        await provide(claim === undefined ? undefined : claim.port);
        if (claim !== undefined) {
          await claim.stop();
        }
      },
      { scope: 'worker' },
    ],
    /**
     * WebKit on macOS, and every visual project's browser, is Playwright's own Linux build in the
     * container the stack host starts; baselines match only the architecture that drew them.
     */
    connectOptions: [
      async ({ browserName, visual }, provide): Promise<void> => {
        if (visual && arch() !== BASELINE_ARCH) {
          throw new Error(
            `The baselines were drawn on ${BASELINE_ARCH} and this machine is ${arch()}: its Linux image renders differently, so the visual projects run on ${BASELINE_ARCH} alone`,
          );
        }
        const remote = visual || browserName === 'webkit';
        const wsEndpoint = remote ? endpointOf(browserName, process.env[LINUX_ENV]) : undefined;
        if (remote && (visual || platform() === 'darwin') && wsEndpoint === undefined) {
          throw new Error(
            'WebKit on macOS and the visual projects run only in the Linux image: its setup project starts it',
          );
        }
        // The image's browser reaches the host's loopback through the host's proxy (stack/socks.ts).
        await provide(wsEndpoint === undefined ? undefined : { wsEndpoint });
      },
      { scope: 'worker' },
    ],
    /** The browser trusts the edge as every other harness browser does (browserTrust). */
    launchOptions: [
      async ({ launchOptions, cdpPort, browserName, stack }, provide): Promise<void> => {
        const debugging =
          cdpPort === undefined ? [] : [`--remote-debugging-port=${String(cdpPort)}`];
        const trusting = browserTrust(stack.trust, browserName).args;
        const args = [...(launchOptions.args ?? []), ...debugging, ...trusting];
        await provide(Object.assign(structuredClone(launchOptions), { args }));
      },
      { scope: 'worker' },
    ],
    ignoreHTTPSErrors: async ({ browserName, connectOptions, stack }, provide): Promise<void> => {
      const contained = connectOptions !== undefined;
      await provide(browserTrust(stack.trust, browserName, contained).ignoreHTTPSErrors);
    },
    baseURL: async ({ stack }, provide): Promise<void> => {
      await provide(stack.baseURL);
    },
    /** The test's context, made once its stack hold, seats and CPU turn are held; named to the edge,
     *  its every request, frame and console line a move its watch hears. */
    context: async (
      { cpuTurn: _turn, context, progress, row, stack },
      provide,
      testInfo,
    ): Promise<void> => {
      if (testInfo.tags.includes(API)) {
        throw new Error(`an ${API} test makes no page: it is written with apiTest`);
      }
      hearProgress(context, progress);
      await joinEdge(context, stack.baseURL, row === undefined ? 'wired' : row.network);
      await provide(context);
    },
    /** A page test's watch starts once its CPU turn is held, as seats and turns are waits, not its
     *  own work; still automatic, as apiTest's is. */
    progress: async ({ cpuTurn: _turn }, provide, testInfo): Promise<void> => {
      await watchedTest(provide, testInfo);
    },
    devices: async (
      {
        context: _context,
        browser,
        browserContexts,
        ignoreHTTPSErrors,
        progress,
        row,
        stack,
        visual,
      },
      provide,
    ): Promise<void> => {
      const opened: BrowserContext[] = [];
      const reserve = deviceBudget(browserContexts);
      const newDevice = async (options: BrowserContextOptions = {}): Promise<Page> => {
        const giveBack = reserve();
        const settings = Object.assign(
          structuredClone(options),
          {
            baseURL: options.baseURL ?? stack.baseURL,
            ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? ignoreHTTPSErrors,
          },
          visual && !('reducedMotion' in options) ? { reducedMotion: VISUAL_MOTION } : {},
        );
        const device = await browser.newContext(settings).catch((error: unknown) => {
          giveBack();
          throw error;
        });
        opened.push(device);
        device.once('close', giveBack);
        hearProgress(device, progress);
        await joinEdge(device, stack.baseURL, row === undefined ? 'wired' : row.network);
        return device.newPage();
      };
      try {
        await provide({ newDevice });
      } finally {
        await Promise.all(opened.map(async (device) => device.close()));
      }
    },
    /** Measures every document, and slows the CPU on Chromium's low tier (DevTools protocol). */
    page: async ({ page, row, browserName, stack }, provide): Promise<void> => {
      await installVitals(page, stack.apiPrefix);
      const rate = slowdownOf(row, browserName);
      if (rate > 1) {
        const session = await page.context().newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate });
      }
      await provide(page);
    },
    channels: [{}, { option: true }],
    reconnect: [undefined, { option: true }],
    keyboardOnly: [false, { option: true }],
    /** Taken after the stack hold, so every holder is a test with its stack, and before the CPU
     *  turn, which a holder may wait on: a test waiting for seats holds no turn. The wait is not the
     *  test's, and fails should the seats stand still (stack/lock.ts). */
    browserSeat: [
      async (
        { stackHold: _held, browserName, browserContexts, visual },
        provide,
        testInfo,
      ): Promise<void> => {
        if (!servedByImage(browserName, visual) || process.env[HOST_ENV] === undefined) {
          await provide(false);
          return;
        }
        const release = await waitedFor(async () => holdBrowserSeat(browserContexts));
        announceTimeout(testInfo.timeout);
        try {
          await provide(true);
        } finally {
          release();
        }
      },
      { timeout: 0 },
    ],
    /** A CPU turn, taken last as every turn is, spans the test's own work; its wait is not the
     *  test's. */
    cpuTurn: [
      async ({ browserSeat: _seated }, provide, testInfo): Promise<void> => {
        const release = await waitedFor(holdTestTurn);
        announceTimeout(testInfo.timeout);
        try {
          await provide(true);
        } finally {
          release();
        }
      },
      { auto: true, timeout: 0 },
    ],
    meter: [
      async ({ page, stack, channels, reconnect }, provide): Promise<void> => {
        const options = { apiPrefix: stack.apiPrefix, channels, vitals: false, reconnect };
        const meter =
          process.env[MEASURE_ENV] === '1' ? await startMeter(page, options) : undefined;
        await provide(meter);
        if (meter !== undefined) {
          meter.traffic.stop();
        }
      },
      { auto: true },
    ],
    /** The report is waited for by an event on its folder, within a bound of its own, outside the
     *  test's time: macOS writes it some seconds after the crash. */
    browserCrash: [browserWatch(), { auto: true, timeout: REPORT_WAIT_MS + 30_000 }],
    invariants: [
      async ({ page, stack, keyboardOnly, browserName }, provide, testInfo): Promise<void> => {
        const { origin } = new URL(stack.baseURL);
        const { apiPrefix, notices, cspExceptions } = stack;
        const today = new Date().toISOString().slice(0, 10);
        const exceptions = { list: cspExceptions ?? [], engine: browserName, today };
        const watched = await watch(page, { origin, apiPrefix, notices, keyboardOnly, exceptions });
        await provide(watched);
        const problems = await watched.take();
        if (testInfo.status !== testInfo.expectedStatus) {
          const body = failureReport(page, problems, watched.recentApi());
          await testInfo.attach(FAILURE_ATTACHMENT, { body, contentType: 'text/plain' });
        }
        expect(problems, 'the page held every invariant').toEqual([]);
      },
      { auto: true },
    ],
  }),
);

export { expect } from '@playwright/test';
