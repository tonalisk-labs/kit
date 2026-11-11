import { request } from 'node:http';

import { test } from '@playwright/test';

import { WHOLE } from './gate-server.ts';
import { type HoldKind, openHold } from './hold.ts';

/** The variable naming the stack host, set by the global setup for every worker. */
export const HOST_ENV = 'KIT_STACK_HOST';

/** The variable naming the URL a run's tests hold their CPU turns at (stack/gate-server.ts). */
export const CPU_GATE_ENV = 'KIT_CPU_GATE';

/** `1` for a measuring run: the rows run the measured journeys and nothing else. */
export const MEASURE_ENV = 'KIT_MEASURE';

/** The variable a target's projects read their stack's coordinates from. */
export const STACK_ENV = 'KIT_STACK';

/** The Linux browser server's key: WebKit rows use it on macOS, whose WebKit guards CryptoKeys with
 *  a keychain prompt, and the visual projects' Chromium, so screenshots match on every machine. */
export const LINUX_BROWSERS = 'linux-browsers';

/** The variable WebKit rows and the visual projects read that server's endpoint from. */
export const LINUX_ENV = 'KIT_LINUX_BROWSERS';

export type Action = 'start' | 'stop' | 'restart';

const isEnv = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value).every((entry) => typeof entry === 'string');

const required = (name: string, starter: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is unset: ${starter}`);
  }
  return value;
};

/** Asks the stack host to start or stop a target's services, answering its projects' environment.
 *  Plain `node:http`, so no client timeout cuts off a long build: the setup project's bounds it. */
export const control = async (action: Action, key: string): Promise<Record<string, string>> => {
  const host = required(HOST_ENV, 'the stack host starts in the global setup');
  const url = new URL(`/${action}/${encodeURIComponent(key)}`, host);
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, string>>();
  const call = request(url, { method: 'POST' }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = response.statusCode === 200 ? JSON.parse(text) : undefined;
      if (isEnv(body)) {
        resolve(body);
      } else {
        reject(new Error(`the stack host could not ${action} ${key}: ${text}`));
      }
    });
  });
  call.on('error', reject);
  call.end();
  return promise;
};

/** Who asks for a hold, for its server's holder record: the running test, if any, its worker and
 *  its process, so a wait past its bound names who held what. */
const holderName = (): string => {
  const worker = process.env['TEST_WORKER_INDEX'];
  const where = `${worker === undefined ? '' : `worker ${worker}, `}pid ${String(process.pid)}`;
  try {
    const info = test.info();
    return `${info.project.name} › ${info.title} (${where})`;
  } catch {
    return where;
  }
};

/**
 * Holds a target's stack, shared or owned alone, until the returned release is called: the hold
 * is an open request, so a worker that dies releases it by closing its connection.
 */
export const holdStack = async (hold: 'share' | 'own', key: string): Promise<() => void> =>
  openHold(
    new URL(
      `/${hold}/${encodeURIComponent(key)}`,
      required(HOST_ENV, 'the stack host starts in the global setup'),
    ),
    {
      held: `a ${hold} hold on ${key}`,
      refused: () => `the stack host refused a ${hold} hold on ${key}`,
    },
    { who: holderName() },
  );

/** A seat among the Linux image's browsers for each context the worker's tests have open at once,
 *  all taken together and held as a stack hold is, for the worker's life. */
export const holdBrowserSeat = async (contexts: number): Promise<() => void> =>
  openHold(
    new URL(
      `/browser/${String(contexts)}`,
      required(HOST_ENV, 'the stack host starts in the global setup'),
    ),
    {
      held: 'seats among the Linux browsers',
      refused: (status) =>
        status === 400
          ? `the Linux browsers seat fewer than the ${String(contexts)} browserContexts declared`
          : 'the stack host refused seats among the Linux browsers',
    },
    { who: holderName() },
  );

const runTurns = (): string => required(CPU_GATE_ENV, 'the global setup joins the CPU gate');

const TURN: HoldKind = {
  held: 'a CPU turn',
  refused: (status) =>
    `the CPU gate refused a turn (${String(status)}): the run has left it, or lost it`,
};

/** A CPU turn, until the returned release; an abort gives up a turn still waiting. */
export const holdTurn = async (turns: string, signal?: AbortSignal): Promise<() => void> =>
  openHold(new URL(turns), TURN, { signal, who: holderName() });

/** A test's CPU turn: its release, its widening once claimed, and the test's end, which gives up
 *  a widening still waiting, so no every-slot turn is granted after its test. */
interface TestTurn {
  release: () => void;
  widened: Promise<void> | undefined;
  readonly ended: AbortController;
}

/** The running test's CPU turn in this worker, which runs one test at a time. */
const worker: { held: TestTurn | undefined } = { held: undefined };

/** One slot, until the returned release. */
export const holdTestTurn = async (): Promise<() => void> => {
  const held: TestTurn = {
    release: await holdTurn(runTurns()),
    widened: undefined,
    ended: new AbortController(),
  };
  worker.held = held;
  return () => {
    worker.held = undefined;
    held.ended.abort();
    held.release();
  };
};

/** A running test's timeout, as Playwright's TestInfo holds it: 0 for none. */
export interface TestTimeout {
  readonly timeout: number;
  readonly setTimeout: (ms: number) => void;
}

/** Trades the slot for every slot, the slot going first, so two widening tests never wait on each
 *  other. The wait is the run's queue, not the test's work, so the test's timeout stops for it. */
const widen = async (held: TestTurn, info: TestTimeout): Promise<void> => {
  held.release();
  const { timeout } = info;
  const asked = performance.now();
  if (timeout > 0) {
    info.setTimeout(0);
  }
  try {
    held.release = await holdTurn(`${runTurns()}/${WHOLE}`, held.ended.signal);
  } finally {
    if (timeout > 0) {
      info.setTimeout(timeout + Math.ceil(performance.now() - asked));
    }
  }
};

/** Widens the running test's turn to every slot, to its end, for figures other work would skew.
 *  The widening is claimed before any wait, so a test widens once however often it asks. */
export const widenTestTurn = async (info: TestTimeout = test.info()): Promise<void> => {
  const { held } = worker;
  if (held === undefined) {
    throw new Error('only a running test, holding its CPU turn, widens it');
  }
  held.widened ??= widen(held, info);
  await held.widened;
};

export const inStackTurn = async <Value>(
  turns: string,
  work: () => Promise<Value>,
): Promise<Value> => {
  const release = await holdTurn(turns);
  try {
    return await work();
  } finally {
    release();
  }
};
