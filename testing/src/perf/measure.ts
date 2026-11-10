import { expect, type Locator, type Page, test } from '@playwright/test';

import { pageScript } from '../checks/in-page.ts';
import { type Row, rowName } from '../matrix.ts';
import { type Network, profileOf } from '../network.ts';
import { isObject } from '../unknown.ts';
import { ceiling, journeyBudget, knownFindings } from './budgets.ts';
import type { Resource } from './collector.ts';
import { pageCpuClock } from './cpu.ts';
import {
  collectReconnectCalls,
  collectSockets,
  SOCKET_KIT,
  reconnectCalls,
  noneConnecting,
  socketOpened,
  socketsConnected,
  type Split,
  splitReconnects,
} from './sockets.ts';
import { beginStamps, collectGaps, collectStamps, endStamps, type Seen } from './stamps.ts';
import { JOURNEY_ATTACHMENT } from './steps.ts';
import { type Exchange, type Tally, type Traffic, watchTraffic } from './traffic.ts';
import { installVitals, readVitals, resetVitals, type Vitals } from './vitals.ts';

/** The requests reconnecting one dropped socket makes: their paths, and how many. */
export interface Reconnect {
  readonly paths: RegExp;
  readonly perDrop: number;
}

/** A page measured step by step: its stamps in the page, its context's traffic in Node. */
export interface Meter {
  readonly traffic: Traffic;
  readonly reconnect: Reconnect | undefined;
}

export interface MeterOptions {
  readonly apiPrefix: string | undefined;
  /** Live sockets' channels by path, such as a change feed and a relay. */
  readonly channels: Readonly<Record<string, RegExp>>;
  /** Whether the page still needs the vitals collector, which the fixture's own page has. */
  readonly vitals: boolean;
  /** How the app reconnects a dropped socket; without it no request is a reconnect's. */
  readonly reconnect: Reconnect | undefined;
}

const STAMPS = 'sites.testing.stamps';
const SOCKETS = 'sites.testing.sockets';

/** A step's outcome shows when its work is done, however long a cold load over 3G takes, so the
 *  test's own time is its only bound. */
const VISIBLE = { state: 'visible', timeout: 0 } as const;

/** The long-task threshold: what a frame blocks past it is what LoAF calls blocking. */
const LONG_TASK_MS = 50;

/** The metrics held to a hard ceiling on every row. `cpuMs`, the page's main-thread CPU time, is
 *  measured on full-speed rows alone, as on a throttled one it would measure the throttle. */
const COUNTED = new Set([
  'requests',
  'blocking',
  'serialPhases',
  'bytesUp',
  'bytesDown',
  'wsFrames',
  'cpuMs',
]);

const meters = new WeakMap<Page, Meter>();

/** Meters a page from its next document on; the context's traffic is watched from now. */
export const startMeter = async (page: Page, options: MeterOptions): Promise<Meter> => {
  if (options.vitals) {
    await installVitals(page, options.apiPrefix);
  }
  await page.addInitScript(collectStamps, { key: STAMPS });
  await page.addInitScript(collectGaps, { key: STAMPS });
  await page.addInitScript({
    content: pageScript(SOCKET_KIT, collectSockets, { key: SOCKETS }),
  });
  await page.addInitScript(collectReconnectCalls, { key: SOCKETS });
  const meter = {
    traffic: watchTraffic(page.context(), options.channels),
    reconnect: options.reconnect,
  };
  meters.set(page, meter);
  return meter;
};

/** How many runs of requests the step waited through one after another: overlapping spans
 *  are one phase, each gap between them starts another. */
export const serialPhases = (spans: readonly (readonly [number, number])[]): number => {
  const sorted = spans.toSorted(([one], [other]) => one - other);
  const reach = { end: Number.NEGATIVE_INFINITY, phases: 0 };
  for (const [start, end] of sorted) {
    reach.phases += start > reach.end ? 1 : 0;
    reach.end = Math.max(reach.end, end);
  }
  return reach.phases;
};

/** One frame at 60 Hz: a request ending within it of the outcome's frame may or may not have
 *  been waited for, so only one ending earlier counts as blocking. */
const FRAME_MS = 1000 / 60;

/** The requests the outcome waited for: started in the step, ended over a frame before it showed. */
export const blockingOf = (
  resources: readonly Resource[],
  seen: Pick<Seen, 'from' | 'visibleAt'>,
): Resource[] =>
  resources.filter(
    (resource) => resource.start >= seen.from && resource.end < seen.visibleAt - FRAME_MS,
  );

/** What blocked the step's frames: LoAF's own blocking time, or past 50 ms of each long gap. */
const blockedMs = (vitals: Vitals, seen: Seen): number =>
  vitals.longFrames.length > 0
    ? vitals.longFrames.reduce((sum, [, blocking]) => sum + blocking, 0)
    : seen.gaps.reduce((sum, [, gap]) => sum + Math.max(0, gap - LONG_TASK_MS), 0);

const bytesOf = (exchanges: readonly Exchange[], way: 'up' | 'down'): number =>
  exchanges.reduce((total, exchange) => total + exchange[way], 0);

const metricsOf = (
  seen: Seen,
  vitals: Vitals,
  { tally, split }: { readonly tally: Tally; readonly split: Split },
): Record<string, number> => {
  const blocking = blockingOf(vitals.resources, seen);
  const api = blocking.filter((resource) => resource.api);
  const channels = Object.entries(tally.channels);
  const { own, reconnecting } = split;
  const metrics: Record<string, number> = {
    requests: own.length,
    blocking: blocking.length + (seen.navigated ? 1 : 0),
    blockingApi: api.length,
    serialPhases: serialPhases(api.map(({ start, end }) => [start, end])),
    bytesUp: bytesOf(own, 'up') + tally.socketUp,
    bytesDown: bytesOf(own, 'down') + tally.socketDown,
    wsFrames: channels.reduce((sum, [, { frames }]) => sum + frames, 0),
    sockets: tally.sockets,
    failed: own.filter((exchange) => exchange.failed).length,
    reconnects: reconnecting.length,
    reconnectBytes: bytesOf(reconnecting, 'up') + bytesOf(reconnecting, 'down'),
    visibleMs: Math.max(0, seen.visibleAt - seen.from),
    loafMs: blockedMs(vitals, seen),
  };
  for (const [name, { frames }] of channels) {
    metrics[`${name}Frames`] = frames;
  }
  if (seen.navigated && vitals.lcp !== undefined) {
    metrics['lcp'] = vitals.lcp;
  }
  const slowest = Math.max(0, ...vitals.events.map(([, duration]) => duration));
  if (vitals.events.length > 0) {
    metrics['inp'] = slowest;
  }
  return metrics;
};

const isRow = (value: unknown): value is Row =>
  isObject(value) && typeof value['number'] === 'number' && typeof value['gated'] === 'boolean';

const projectOf = (): { readonly target: string; readonly row: Row } => {
  const { use } = test.info().project;
  const target: unknown = Reflect.get(use, 'site');
  const row: unknown = Reflect.get(use, 'row');
  if (typeof target !== 'string' || !isRow(row)) {
    throw new Error('a measured step runs in a target row project');
  }
  return { target, row };
};

const overs = (metrics: Readonly<Record<string, number>>, ceilings: object): string[] =>
  Object.entries(ceilings).flatMap(([id, most]: [string, unknown]) => {
    const value = metrics[id];
    return typeof most === 'number' && value !== undefined && value > most
      ? [`${id} ${value.toFixed(1)} is over its budget of ${String(most)}`]
      : [];
  });

const labels = (exchanges: readonly Exchange[]): string =>
  exchanges.map(({ label }) => label).join(', ') || 'none';

/** Google's "good" for the timings a step can have, by the audit id its ceiling is kept under. */
const GOOD = [
  ['lcp', 'largest-contentful-paint'],
  ['inp', 'interaction-to-next-paint'],
] as const;

/** The most reconnect requests a step can cause: a drop per shortest socket life its network
 *  allows, and those it makes itself. */
const reconnectCeiling = (
  meter: Meter,
  step: { readonly network: Network; readonly lengthMs: number; readonly drops: number },
): number => {
  const profile = profileOf(step.network);
  const lifetime = profile === undefined ? undefined : profile.socketLifetimeMs;
  if (meter.reconnect === undefined) {
    return 0;
  }
  const dropped = lifetime === undefined ? 0 : Math.ceil(step.lengthMs / lifetime[0]);
  return (dropped + step.drops) * meter.reconnect.perDrop;
};

/** Reports a gated row's timings against Google's "good", as a busy machine stretches the wall
 *  clock while CPU time is held: a known breach prints as known, a fixed one as removable. */
const holdToGood = (
  at: { readonly target: string; readonly step: string; readonly row: string },
  metrics: Readonly<Record<string, number>>,
): void => {
  const known = knownFindings().filter(
    ({ target, step, row }) => target === at.target && step === at.step && row === at.row,
  );
  const listed = new Set(known.map(({ metric }) => metric));
  const breaches = GOOD.filter(([id, audit]) => (metrics[id] ?? 0) > ceiling(audit));
  for (const [id, audit] of breaches.filter(([breached]) => listed.has(breached))) {
    const value = String(Math.round(metrics[id] ?? 0));
    console.log(
      `${at.step} (row ${at.row}): known finding: ${id} ${value} is over ${String(ceiling(audit))}`,
    );
  }
  for (const id of listed) {
    if (!breaches.some(([breached]) => breached === id)) {
      console.log(
        `${at.step} (row ${at.row}): known finding ${id} is within "good" now; its entry can be removed`,
      );
    }
  }
  const unlisted = Object.fromEntries(
    GOOD.filter(([id]) => !listed.has(id)).map(([id, audit]) => [id, ceiling(audit)]),
  );
  for (const over of overs(metrics, unlisted)) {
    console.log(`${at.step} (row ${at.row}): ${over} is over Google's "good" (reported only)`);
  }
};

interface Held {
  readonly step: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly split: Split;
  /** The most reconnect requests its network allows. */
  readonly reconnects: number;
}

/** Holds a step to its budget: counts, bytes and phases hard, reconnects to what its network can
 *  cause. Timings are reported only: past their row's +10%, and on a gated row past "good". */
const holdToBudget = ({ step, metrics, split, reconnects }: Held): void => {
  const { target, row } = projectOf();
  const made = `${step}: reconnects; requests: ${labels(split.reconnecting)}`;
  expect(overs(metrics, { reconnects }), made).toEqual([]);
  if (row.gated) {
    holdToGood({ target, step, row: String(row.number).padStart(2, '0') }, metrics);
  }
  const budget = journeyBudget(target, step);
  if (budget === undefined) {
    return;
  }
  const counted = Object.fromEntries(
    Object.entries(budget.counted).filter(([id]) => COUNTED.has(id)),
  );
  const requests = `${step}: counts, bytes and phases; requests: ${labels(split.own)}`;
  expect(overs(metrics, counted), requests).toEqual([]);
  const timed = budget.timed[String(row.number).padStart(2, '0')];
  const slower = timed === undefined ? [] : overs(metrics, timed);
  if (slower.length > 0) {
    console.log(`${step}: timings past their measured +10% (reported only): ${slower.join('; ')}`);
  }
};

/** What a step does, and the outcome that shows it done. */
export interface JourneyStep {
  readonly act: () => Promise<unknown>;
  readonly visible: Locator;
  /** What shows the step's work all sent, such as a saved status, when that comes after. */
  readonly settled?: Locator;
  /** The network the step runs on, when it is not its row's. */
  readonly network?: Network;
  /** A live socket the step's work ends by opening, such as the feed a booting app opens once
   *  its library is in: what the opening costs is the step's. */
  readonly opens?: RegExp;
  /** Live sockets the step itself drops, as coming back online after going offline does. */
  readonly drops?: number;
}

/** In the page: resolves after its next frame and the task that frame queued, in every engine
 *  (WebKit has no idle callback). */
const afterFrame = async (): Promise<void> =>
  new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => {
      const { port1, port2 } = new globalThis.MessageChannel();
      port1.addEventListener('message', () => {
        resolve();
      });
      port1.start();
      port2.postMessage('frame');
    });
  });

/** The longest a socket may take to connect before the step fails saying so. */
const CONNECT_MS = 60_000;

/** Fails naming `what` when `waited` takes longer than CONNECT_MS. */
const within = async (waited: Promise<void>, what: string): Promise<void> => {
  const timer: { id?: NodeJS.Timeout } = {};
  const expired = new Promise<never>((_resolve, reject) => {
    timer.id = setTimeout(() => {
      reject(new Error(`waited ${String(CONNECT_MS)} ms for ${what}`));
    }, CONNECT_MS);
  });
  try {
    await Promise.race([waited, expired]);
  } finally {
    clearTimeout(timer.id);
  }
};

const connected = async (page: Page): Promise<void> =>
  within(page.evaluate(socketsConnected, SOCKETS), 'the sockets to connect');

/** The step's own requests are done once all it started have finished and the page, at rest,
 *  starts no more: a pull's next page follows the one before it. */
const quiet = async (page: Page, meter: Meter): Promise<void> => {
  const started = meter.traffic.started();
  await meter.traffic.finished();
  await connected(page);
  await page.evaluate(afterFrame);
  if (meter.traffic.started() !== started) {
    await quiet(page, meter);
  }
};

/** Resolves once every request is answered, no socket is connecting, and a frame of the
 *  page starts nothing new: what an answer sets off (a socket, its catch-up) comes first. */
const atRest = async (page: Page, meter: Meter): Promise<void> => {
  const started = meter.traffic.started();
  await meter.traffic.settled();
  await connected(page);
  await page.evaluate(afterFrame);
  if (meter.traffic.started() !== started || !(await page.evaluate(noneConnecting, SOCKETS))) {
    await atRest(page, meter);
  }
};

/** Starts a step once what the last one set off is answered, so none of it counts as this
 *  step's; answers its start on the page's clock. */
const begin = async (page: Page, meter: Meter): Promise<number> => {
  await atRest(page, meter);
  await resetVitals(page);
  await meter.traffic.take();
  return page.evaluate(beginStamps, STAMPS);
};

/** When the step's outcome showed: it is waited for, then dated by the page's stamps. */
const outcome = async (
  page: Page,
  { visible, begun }: { readonly visible: Locator; readonly begun: number },
): Promise<Seen> => {
  await visible.waitFor(VISIBLE);
  const element = await visible.elementHandle();
  const seen = await page.evaluate(endStamps, [element, STAMPS, begun] as const);
  await element.dispose();
  return seen;
};

const workDone = async (
  page: Page,
  { settled, opens }: Pick<JourneyStep, 'settled' | 'opens'>,
): Promise<void> => {
  if (settled !== undefined) {
    await settled.waitFor(VISIBLE);
  }
  if (opens !== undefined) {
    await within(page.evaluate(socketOpened, [SOCKETS, opens.source] as const), 'a socket to open');
  }
};

const splitOf = async (
  page: Page,
  meter: Meter,
): Promise<{ readonly tally: Tally; readonly split: Split }> => {
  const tally = await meter.traffic.take();
  const calls = await page.evaluate(reconnectCalls, SOCKETS);
  const paths = meter.reconnect === undefined ? undefined : meter.reconnect.paths;
  return { tally, split: splitReconnects(tally.exchanges, { calls, paths }) };
};

/** A step from its start to rest, `act`, its outcome, its work and its traffic, and what it cost,
 *  with the page's CPU time on full-speed rows, as a throttled row's is the throttle's. */
const stepRun = async (
  page: Page,
  meter: Meter,
  step: JourneyStep,
): Promise<{ metrics: Record<string, number>; traffic: { tally: Tally; split: Split } }> => {
  const begun = await begin(page, meter);
  const spent = projectOf().row.cpu === 'high' ? await pageCpuClock(page) : undefined;
  await step.act();
  const seen = await outcome(page, { visible: step.visible, begun });
  await workDone(page, step);
  await quiet(page, meter);
  const cpu = spent === undefined ? undefined : await spent();
  const vitals = await readVitals(page);
  const traffic = await splitOf(page, meter);
  const metrics = metricsOf(seen, vitals, traffic);
  if (cpu !== undefined) {
    metrics['cpuMs'] = Math.round(cpu);
  }
  return { metrics, traffic };
};

/** Measures one step, from `act` to its `visible` outcome and settled traffic, as blocking
 *  requests, long frames, LCP, the slowest interaction and CPU time, held to its budget. */
export const measureStep = async (
  page: Page,
  name: string,
  step: JourneyStep,
): Promise<Readonly<Record<string, number>>> => {
  const meter = meters.get(page);
  if (meter === undefined) {
    throw new Error('measureStep needs a metered page (startMeter, or the meter fixture)');
  }
  const since = Date.now();
  const { metrics, traffic } = await stepRun(page, meter, step);
  const { target, row } = projectOf();
  await test.info().attach(JOURNEY_ATTACHMENT, {
    body: JSON.stringify({ target, row: rowName(row), step: name, metrics }),
    contentType: 'application/json',
  });
  const length = Date.now() - since;
  const reconnects = reconnectCeiling(meter, {
    network: step.network ?? row.network,
    lengthMs: length,
    drops: step.drops ?? 0,
  });
  holdToBudget({ step: name, metrics, split: traffic.split, reconnects });
  return metrics;
};
