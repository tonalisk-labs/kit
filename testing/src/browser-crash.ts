// What a browser lost mid-test died of, from the crash report macOS writes for it as JSON
// (`.ips`): a header line, then the report, which names the process's parent: the worker, or a
// process the worker started for it.
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import type { Browser } from '@playwright/test';

import { run } from './stack/process.ts';

/** Where macOS writes crash reports: the user's own, and the system's, where a browser's land. */
const REPORT_FOLDERS: readonly string[] = [
  path.join(homedir(), 'Library/Logs/DiagnosticReports'),
  '/Library/Logs/DiagnosticReports',
];

/** How long a lost browser's report is waited for. ReportCrash wrote Firefox's 24 s after it
 *  died on a loaded Mac; a process killed outright gets none, so the wait has a bound. */
export const REPORT_WAIT_MS = 60_000;

export interface CrashReport {
  readonly file: string;
  readonly pid: number;
  readonly parentPid: number;
  /** The crashed process's name, its exception and signal, and the thread that faulted. */
  readonly summary: string;
  /** The faulting thread's innermost frames, each `image: symbol`, or its offset unsymbolicated. */
  readonly frames: readonly string[];
}

/** How many of the faulting thread's frames a summary keeps. */
const DEPTH = 8;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const numberOf = (value: unknown): number => (typeof value === 'number' ? value : -1);

/** A report's body, after its header line, or nothing if it isn't JSON. */
const bodyOf = (text: string): unknown => {
  const [, ...rest] = text.split('\n');
  try {
    return JSON.parse(rest.join('\n'));
  } catch {
    return undefined;
  }
};

/** Each frame as `image: symbol`, the image looked up among the report's loaded images. */
const framesOf = (frames: unknown, images: unknown[]): string[] =>
  listOf(frames)
    .slice(0, DEPTH)
    .map((frame) => {
      const entry = isObject(frame) ? frame : {};
      const image = images[numberOf(entry['imageIndex'])];
      const name = isObject(image) ? textOf(image['name']) : '';
      const offset = numberOf(entry['imageOffset']);
      const at = offset < 0 ? '?' : `+0x${offset.toString(16)}`;
      return `${name || '?'}: ${textOf(entry['symbol']) || at}`;
    });

/** The report in `file`'s `text`, if it is one: who crashed, of what, on which thread. */
export const crashReportOf = (file: string, text: string): CrashReport | undefined => {
  const report = bodyOf(text);
  if (!isObject(report) || !isObject(report['exception'])) {
    return undefined;
  }
  const { exception } = report;
  const threads = listOf(report['threads']);
  const faulting = threads[numberOf(report['faultingThread'])];
  const thread = isObject(faulting) ? faulting : {};
  const fault = [exception['type'], exception['signal'], exception['subtype']].map((part) =>
    textOf(part),
  );
  const on = textOf(thread['name']) === '' ? '' : ` on its thread ${textOf(thread['name'])}`;
  return {
    file,
    pid: numberOf(report['pid']),
    parentPid: numberOf(report['parentPid']),
    summary: `${textOf(report['procName'])} ${fault.filter(Boolean).join(' ')}${on}`,
    frames: framesOf(thread['frames'], listOf(report['usedImages'])),
  };
};

/** The reports in `folder`, or none if it can't be read. */
const reportFilesIn = (folder: string): string[] => {
  try {
    return readdirSync(folder)
      .filter((name) => name.endsWith('.ips'))
      .map((name) => path.join(folder, name));
  } catch {
    return [];
  }
};

/** The report in `file`, if it was written since `since` (ms since the epoch) and is one; a file
 *  macOS removed or is still writing is none yet. */
const reportIn = (file: string, since: number): CrashReport | undefined => {
  try {
    const written = statSync(file, { throwIfNoEntry: false });
    return written !== undefined && written.mtimeMs >= since
      ? crashReportOf(file, readFileSync(file, 'utf8'))
      : undefined;
  } catch {
    return undefined;
  }
};

/** The report in `folders`, written since `since`, of a process one of `parents` started, the
 *  earlier parent first: the worker's own child, the browser, ahead of a helper of the browser's. */
const firstReport = (
  folders: readonly string[],
  { parents, since }: { readonly parents: readonly number[]; readonly since: number },
): CrashReport | undefined => {
  const written = folders
    .flatMap((folder) => reportFilesIn(folder))
    .toSorted()
    .map((file) => reportIn(file, since))
    .filter((report): report is CrashReport => report !== undefined);
  return parents
    .map((parent) => written.find((report) => report.parentPid === parent))
    .find((report) => report !== undefined);
};

/** Calls `look` on each change in `folder` until `signal` ends, if the folder can be watched. */
const watchFolder = (folder: string, signal: AbortSignal, look: () => void): void => {
  try {
    watch(folder, { signal }, look).on('error', look);
  } catch {
    // Looked into once more by the caller all the same.
  }
};

export interface ReportWanted {
  /** The processes whose child's report is wanted: the worker, and those it had started. */
  readonly parents: readonly number[];
  readonly since: number;
  readonly folders: readonly string[];
  /** Ends the wait: nothing was written in time. */
  readonly signal: AbortSignal;
}

/** The crash report of a process one of `parents` started, as soon as macOS writes it into one
 *  of `folders`; if `signal` ends the wait first, whatever is there by then. */
export const crashReportFor = async ({
  parents,
  since,
  folders,
  signal,
}: ReportWanted): Promise<CrashReport | undefined> => {
  const found = Promise.withResolvers<CrashReport | undefined>();
  const look = (): void => {
    const report = firstReport(folders, { parents, since });
    if (report !== undefined) {
      found.resolve(report);
    }
  };
  const ended = new AbortController();
  const watching = AbortSignal.any([signal, ended.signal]);
  if (watching.aborted) {
    return firstReport(folders, { parents, since });
  }
  for (const folder of folders.filter((one) => existsSync(one))) {
    watchFolder(folder, watching, look);
  }
  // At the bound, what has been written by then; once found, the wait's own end looks no more.
  watching.addEventListener('abort', () => {
    if (!ended.signal.aborted) {
      found.resolve(firstReport(folders, { parents, since }));
    }
  });
  // A report written before the watches began fires no event of its own.
  look();
  try {
    return await found.promise;
  } finally {
    ended.abort();
  }
};

interface Lost {
  readonly engine: string;
  /** Whether the browser ran in the Linux image, whose crashes macOS never sees. */
  readonly remote: boolean;
  readonly since: number;
  readonly parents: readonly number[];
  readonly folders: readonly string[];
  readonly waitMs: number;
  /** Whether this system writes crash reports: macOS does, Linux doesn't. */
  readonly reports: boolean;
}

/** Why a browser was lost mid-test, in words its test fails with, and its report, if any. */
const lostBrowser = async ({
  engine,
  remote,
  since,
  parents,
  folders,
  waitMs,
  reports,
}: Lost): Promise<{ readonly message: string; readonly report: CrashReport | undefined }> => {
  if (remote || !reports) {
    const where = remote ? 'in the Linux image' : 'on a system that keeps no crash reports';
    return { message: `${engine} was lost mid-test, ${where}`, report: undefined };
  }
  const signal = AbortSignal.timeout(waitMs);
  const report = await crashReportFor({ parents, since, folders, signal });
  if (report === undefined) {
    const waited = `macOS wrote no crash report for it within ${String(waitMs / 1000)} s`;
    return { message: `${engine} was lost mid-test, and ${waited}`, report };
  }
  const frames = report.frames.map((frame) => `\n    ${frame}`).join('');
  const message = `${engine} crashed mid-test: ${report.summary} (pid ${String(report.pid)}, report ${report.file})${frames}`;
  return { message, report };
};

/** How long pgrep may take: a bound on an outside process, never how its answer is awaited. */
const PGREP_BOUND_MS = 10_000;

/** The processes `pid` started, by id alone, as pgrep prints them; none if it finds none. */
const childrenOf = async (pid: number): Promise<number[]> => {
  try {
    const listed = await run('pgrep', ['-P', String(pid)], {
      signal: AbortSignal.timeout(PGREP_BOUND_MS),
    });
    return listed
      .split('\n')
      .map(Number)
      .filter((child) => Number.isInteger(child) && child > 0);
  } catch {
    return [];
  }
};

/** What the worker had started once each browser launched, read once per browser: WebKit runs
 *  under pw_run.sh, which doesn't exec it, so its report's parent is that shell. */
const launchedWith = new WeakMap<object, Promise<number[]>>();

const launchersOf = async (browser: object): Promise<number[]> => {
  const known = launchedWith.get(browser) ?? childrenOf(process.pid);
  launchedWith.set(browser, known);
  return known;
};

/** The attachment a lost browser's crash report is kept under. */
export const CRASH_ATTACHMENT = 'browser crash report';

/** Where a failed test keeps its report: Playwright's `testInfo`. */
export interface Attaching {
  readonly attach: (
    name: string,
    file: { path: string; contentType: string },
  ) => Promise<void> | void;
}

/** What the watch reads of a test's fixtures: its worker's browser, and whether it is remote. */
export interface Watched {
  readonly browser: Pick<Browser, 'isConnected'>;
  readonly browserName: string;
  readonly connectOptions: unknown;
}

/** Fails a test whose browser was lost mid-test as its engine's crash, macOS's report attached. */
export const browserWatch =
  ({ folders = REPORT_FOLDERS, waitMs = REPORT_WAIT_MS, reports = platform() === 'darwin' } = {}) =>
  async (
    { browser, browserName, connectOptions }: Watched,
    provide: (since: number) => Promise<void> | void,
    testInfo: Attaching,
  ): Promise<void> => {
    const since = Date.now();
    // Read before the test runs, while every process the browser was launched with is alive.
    const launchers = reports ? await launchersOf(browser) : [];
    await provide(since);
    if (browser.isConnected()) {
      return;
    }
    const remote = connectOptions !== undefined;
    const parents = [process.pid, ...launchers];
    const lost = { engine: browserName, remote, since, parents, folders, waitMs, reports };
    const { message, report } = await lostBrowser(lost);
    if (report !== undefined) {
      await testInfo.attach(CRASH_ATTACHMENT, { path: report.file, contentType: 'text/plain' });
    }
    throw new Error(message);
  };
