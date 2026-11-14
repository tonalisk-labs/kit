import assert from 'node:assert/strict';
import { mkdtempDisposable, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import {
  type Attaching,
  browserWatch,
  CRASH_ATTACHMENT,
  crashReportFor,
  crashReportOf,
  reportsKnown,
} from '../src/browser-crash.ts';

/** The process a crash report names; `reportText` writes the report as macOS does, a header line
 *  then the report, shaped as a Firefox crash's. */
interface Crashed {
  readonly pid: number;
  readonly parentPid: number;
  readonly procName: string;
}

const reportText = ({ pid, parentPid, procName }: Crashed): string =>
  [
    JSON.stringify({ app_name: procName, bug_type: '309' }),
    JSON.stringify({
      pid,
      parentPid,
      procName,
      exception: {
        type: 'EXC_BAD_ACCESS',
        signal: 'SIGSEGV',
        subtype: 'KERN_INVALID_ADDRESS at 0xe5e5e5e5e5e5e5e5',
      },
      faultingThread: 1,
      threads: [
        { name: 'MainThread', frames: [] },
        {
          name: 'Compositor',
          frames: [
            { imageIndex: 0, imageOffset: 21_433_492 },
            { imageIndex: 1, imageOffset: 27_876, symbol: '_pthread_start' },
          ],
        },
      ],
      usedImages: [{ name: 'XUL' }, { name: 'libsystem_pthread.dylib' }],
    }),
  ].join('\n');

/** A folder of its own for a test's reports, so no test finds another's. */
const reportsFolder = async (): Promise<AsyncDisposable & { readonly path: string }> =>
  mkdtempDisposable(path.join(tmpdir(), 'sites-testing-crashes-'));

/** Writes a report of a crash into `folder`; answers its path. */
const writeReport = async (folder: string, crashed: Crashed): Promise<string> => {
  const file = path.join(folder, `${crashed.procName}-${String(crashed.pid)}.ips`);
  await writeFile(file, reportText(crashed));
  return file;
};

await test('a crash report names the process, its fault and the thread that faulted, frame by frame', () => {
  const text = reportText({ pid: 70_307, parentPid: 70_007, procName: 'firefox' });
  assert.deepEqual(crashReportOf('a.ips', text), {
    file: 'a.ips',
    pid: 70_307,
    parentPid: 70_007,
    summary:
      'firefox EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0xe5e5e5e5e5e5e5e5 on its thread Compositor',
    frames: ['XUL: +0x1470c94', 'libsystem_pthread.dylib: _pthread_start'],
  });
});

await test('a file that is no crash report, or reports no exception, is none', () => {
  assert.equal(crashReportOf('a.ips', 'not a report'), undefined);
  assert.equal(
    crashReportOf('a.ips', `{}\n${JSON.stringify({ pid: 1, parentPid: 2 })}`),
    undefined,
  );
});

await test("the report of a process the worker started is taken once it's written, never another's", async () => {
  await using folder = await reportsFolder();
  const ended = new AbortController();
  const waited = crashReportFor({
    parents: [4],
    known: reportsKnown([folder.path]),
    folders: [folder.path],
    signal: ended.signal,
  });
  await writeReport(folder.path, { pid: 30, parentPid: 3, procName: 'firefox' });
  const ours = await writeReport(folder.path, { pid: 40, parentPid: 4, procName: 'firefox' });
  try {
    const report = await waited;
    assert.ok(report !== undefined, 'the report is found');
    assert.equal(report.file, ours);
    assert.equal(report.pid, 40);
  } finally {
    ended.abort();
  }
});

await test("the browser's own report is taken ahead of its helper's, whichever name sorts first", async () => {
  await using folder = await reportsFolder();
  const known = reportsKnown([folder.path]);
  // A helper's parent is the browser, a process the worker started; the browser's is the worker.
  await writeReport(folder.path, { pid: 41, parentPid: 40, procName: 'Chromium Helper (GPU)' });
  const browsers = await writeReport(folder.path, { pid: 40, parentPid: 4, procName: 'Chromium' });
  const ended = new AbortController();
  ended.abort();
  const report = await crashReportFor({
    parents: [4, 40],
    known,
    folders: [folder.path],
    signal: ended.signal,
  });
  assert.equal(report === undefined ? '' : report.file, browsers);
});

await test('a report written before the wait began is not taken, and the bound ends the wait', async () => {
  await using folder = await reportsFolder();
  await writeReport(folder.path, { pid: 50, parentPid: 5, procName: 'firefox' });
  const ended = new AbortController();
  const waited = crashReportFor({
    parents: [5],
    known: reportsKnown([folder.path]),
    folders: [folder.path],
    signal: ended.signal,
  });
  ended.abort();
  assert.equal(await waited, undefined);
});

/** A test body that has ended by the time the watch looks at its browser. */
const ended = (since: number): void => {
  assert.ok(since <= Date.now(), 'the watch began before the body');
};

/** A test's attachments, as the watch hands them over. */
const attachments = (): Attaching & { readonly kept: string[] } => {
  const kept: string[] = [];
  return {
    attach: (name, { path: file }) => {
      kept.push(`${name}: ${file}`);
    },
    kept,
  };
};

await test("a browser lost mid-test fails its test as its engine's crash, its report attached", async () => {
  await using folder = await reportsFolder();
  const server = await chromium.launchServer();
  const browser = await chromium.connect(server.wsEndpoint());
  const { pid } = server.process();
  assert.ok(pid !== undefined, 'the browser runs as a process of its own');
  const report = { file: '' };
  const watched = browserWatch({ folders: [folder.path], waitMs: 60_000, reports: true });
  const testInfo = attachments();
  const body = async (): Promise<void> => {
    report.file = await writeReport(folder.path, {
      pid,
      parentPid: process.pid,
      procName: 'Chromium',
    });
    const lost = new Promise((resolve) => {
      browser.once('disconnected', resolve);
    });
    server.process().kill('SIGKILL');
    await lost;
  };
  try {
    await assert.rejects(
      watched({ browser, browserName: 'chromium', connectOptions: undefined }, body, testInfo),
      new RegExp(
        `^Error: chromium crashed mid-test: Chromium EXC_BAD_ACCESS SIGSEGV .* on its thread Compositor \\(pid ${String(pid)}, report `,
        'u',
      ),
    );
    assert.deepEqual(testInfo.kept, [`${CRASH_ATTACHMENT}: ${report.file}`]);
  } finally {
    await server.close();
  }
});

await test("a report whose parent the worker had started, as WebKit's launcher is, is the crash too", async () => {
  await using folder = await reportsFolder();
  const server = await chromium.launchServer();
  const browser = await chromium.connect(server.wsEndpoint());
  const { pid } = server.process();
  assert.ok(pid !== undefined, 'the browser runs as a process of its own');
  const watched = browserWatch({ folders: [folder.path], waitMs: 60_000, reports: true });
  const body = async (): Promise<void> => {
    // As pw_run.sh runs WebKit: the report's parent is the worker's own child, not the worker.
    await writeReport(folder.path, { pid: pid + 1, parentPid: pid, procName: 'Playwright' });
    const lost = new Promise((resolve) => {
      browser.once('disconnected', resolve);
    });
    server.process().kill('SIGKILL');
    await lost;
  };
  try {
    await assert.rejects(
      watched({ browser, browserName: 'webkit', connectOptions: undefined }, body, attachments()),
      new RegExp(
        `^Error: webkit crashed mid-test: Playwright .* \\(pid ${String(pid + 1)}, report `,
        'u',
      ),
    );
  } finally {
    await server.close();
  }
});

await test("a report stamped before its watch began, as Linux's coarser clock can stamp one, is the crash all the same", async () => {
  await using folder = await reportsFolder();
  const watched = browserWatch({ folders: [folder.path], waitMs: 60_000, reports: true });
  const testInfo = attachments();
  const report = { file: '' };
  const body = async (since: number): Promise<void> => {
    report.file = await writeReport(folder.path, {
      pid: 60,
      parentPid: process.pid,
      procName: 'firefox',
    });
    // Written after the watch began, stamped a second before it: no clock may decide it's old.
    const stamped = new Date(since - 1000);
    await utimes(report.file, stamped, stamped);
  };
  const lost = { isConnected: (): boolean => false };
  await assert.rejects(
    watched({ browser: lost, browserName: 'firefox', connectOptions: undefined }, body, testInfo),
    /^Error: firefox crashed mid-test: firefox EXC_BAD_ACCESS SIGSEGV .* \(pid 60, report /u,
  );
  assert.deepEqual(testInfo.kept, [`${CRASH_ATTACHMENT}: ${report.file}`]);
});

await test('a browser still connected when its test ends fails nothing', async () => {
  await using folder = await reportsFolder();
  const testInfo = attachments();
  const watched = browserWatch({ folders: [folder.path], waitMs: 0, reports: true });
  const browser = { isConnected: (): boolean => true };
  await watched({ browser, browserName: 'firefox', connectOptions: undefined }, ended, testInfo);
  assert.deepEqual(testInfo.kept, []);
});

await test('a lost browser that leaves no report fails all the same, naming where or how long', async () => {
  await using folder = await reportsFolder();
  const lost = { isConnected: (): boolean => false };
  const fail = async (connectOptions: unknown, reports: boolean, words: RegExp): Promise<void> => {
    const watched = browserWatch({ folders: [folder.path], waitMs: 0, reports });
    const testInfo = attachments();
    await assert.rejects(
      watched({ browser: lost, browserName: 'webkit', connectOptions }, ended, testInfo),
      words,
    );
    assert.deepEqual(testInfo.kept, []);
  };
  await fail(
    { wsEndpoint: 'ws://image' },
    true,
    /^Error: webkit was lost mid-test, in the Linux image$/u,
  );
  await fail(
    undefined,
    false,
    /^Error: webkit was lost mid-test, on a system that keeps no crash reports$/u,
  );
  await fail(
    undefined,
    true,
    /^Error: webkit was lost mid-test, and macOS wrote no crash report for it within 0 s$/u,
  );
});
