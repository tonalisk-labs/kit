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
import { deviceBudget } from './stack/browsers.ts';
import {
  holdBrowserSeat,
  holdStack,
  holdTestTurn,
  HOST_ENV,
  LINUX_ENV,
  MEASURE_ENV,
  STACK_ENV,
} from './stack/control.ts';
import { claimPort } from './stack/ports.ts';
import type { Coordinates } from './stack/stack.ts';
import { browserTrust, trustCa } from './stack/tls.ts';
import { BASELINE_ARCH, VISUAL_MOTION } from './visual.ts';

/** The options every target project sets: its target, and the matrix row it runs on. */
export interface Options {
  readonly site: string;
  readonly row: Row | undefined;
  /** A visual project's: Chromium in the Linux image, holding screens to their baselines. */
  readonly visual: boolean;
  /** The most browser contexts one of the worker's tests has open at once, its own included: a
   *  seat each in the Linux image, which a test of several devices declares with `test.use`. */
  readonly browserContexts: number;
}

/** The tag of a test that disturbs its whole stack, such as a backend restart. */
const EXCLUSIVE = '@exclusive';

/** The tag of a test that makes no page (`apiTest`): run once per target, not on every row. */
const API = '@api';

interface StackWorkerFixtures {
  /** The target's running stack, from its setup project. */
  readonly stack: Coordinates;
  /** Whether the worker's browser holds a seat in the Linux image (stack/browsers.ts). */
  readonly browserSeat: boolean;
}

interface StackFixtures {
  /** Whether this test owns the stack alone (`@exclusive`), or shares it with every other. */
  readonly stackHold: boolean;
}

interface WorkerFixtures {
  /** Chromium's DevTools port, which Lighthouse connects to; no other engine has one. */
  readonly cdpPort: number | undefined;
}

/** Further devices of a test, each a context of its own the test's end closes, pass or fail. */
export interface Devices {
  readonly newDevice: (options?: BrowserContextOptions) => Promise<Page>;
}

interface TestFixtures {
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
> = base.extend<StackFixtures, Options & StackWorkerFixtures>({
  site: ['', { option: true, scope: 'worker' }],
  browserContexts: [1, { option: true, scope: 'worker' }],
  row: [undefined, { option: true, scope: 'worker' }],
  visual: [false, { option: true, scope: 'worker' }],
  /** Taken before any stack hold, so a worker waiting for a seat holds nothing another waits on. */
  browserSeat: [
    async ({ browserName, browserContexts, visual }, provide): Promise<void> => {
      if (!servedByImage(browserName, visual) || process.env[HOST_ENV] === undefined) {
        await provide(false);
        return;
      }
      const release = await holdBrowserSeat(browserContexts);
      try {
        await provide(true);
      } finally {
        release();
      }
    },
    // Unbounded, as each seat's holder is a worker whose tests run under their own timeouts.
    { scope: 'worker', timeout: 0 },
  ],
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
    async ({ site, browserSeat: _seated }, provide, testInfo): Promise<void> => {
      const owns = testInfo.tags.includes(EXCLUSIVE);
      if (site === '' || process.env[HOST_ENV] === undefined) {
        await provide(owns);
        return;
      }
      const release = await holdStack(owns ? 'own' : 'share', site);
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
});

/** A browser the Linux image's server runs, where the stack host started one. */
const servedByImage = (browserName: string, visual: boolean): boolean =>
  (visual || browserName === 'webkit') && process.env[LINUX_ENV] !== undefined;

/** A test on a matrix row: its browser, its page and the invariants every page holds. */
export const test: TestType<
  BaseTest & StackFixtures & TestFixtures,
  BaseWorker & Options & StackWorkerFixtures & WorkerFixtures
> = apiTest.extend<TestFixtures, WorkerFixtures>({
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
    async ({ browserName, visual, browserSeat: _seated }, provide): Promise<void> => {
      if (visual && arch() !== BASELINE_ARCH) {
        throw new Error(
          `The baselines were drawn on ${BASELINE_ARCH} and this machine is ${arch()}: its Linux image renders differently, so the visual projects run on ${BASELINE_ARCH} alone`,
        );
      }
      const remote = visual || browserName === 'webkit';
      const wsEndpoint = remote ? process.env[LINUX_ENV] : undefined;
      if (remote && (visual || platform() === 'darwin') && wsEndpoint === undefined) {
        throw new Error(
          'WebKit on macOS and the visual projects run only in the Linux image: its setup project starts it',
        );
      }
      await provide(
        wsEndpoint === undefined ? undefined : { wsEndpoint, exposeNetwork: '<loopback>' },
      );
    },
    { scope: 'worker' },
  ],
  /** The browser trusts the edge as every other harness browser does (browserTrust). */
  launchOptions: [
    async ({ launchOptions, cdpPort, browserName, stack }, provide): Promise<void> => {
      const debugging = cdpPort === undefined ? [] : [`--remote-debugging-port=${String(cdpPort)}`];
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
  /** The test's context, used once its stack hold and CPU turn are held; named to the edge. */
  context: async ({ stackHold: _held, context, row, stack }, provide, testInfo): Promise<void> => {
    if (testInfo.tags.includes(API)) {
      throw new Error(`an ${API} test makes no page: it is written with apiTest`);
    }
    await joinEdge(context, stack.baseURL, row === undefined ? 'wired' : row.network);
    await provide(context);
  },
  devices: async (
    { context: _context, browser, browserContexts, ignoreHTTPSErrors, row, stack, visual },
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
  /** A CPU turn, taken after the stack hold as every turn is, spans the test's own work; the
   *  override keeps the hold's own timeout, so none of the wait is charged to the test's. */
  stackHold: async ({ stackHold }, provide): Promise<void> => {
    const release = await holdTestTurn();
    try {
      await provide(stackHold);
    } finally {
      release();
    }
  },
  meter: [
    async ({ page, stack, channels, reconnect }, provide): Promise<void> => {
      const options = { apiPrefix: stack.apiPrefix, channels, vitals: false, reconnect };
      const meter = process.env[MEASURE_ENV] === '1' ? await startMeter(page, options) : undefined;
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
});

export { expect } from '@playwright/test';
