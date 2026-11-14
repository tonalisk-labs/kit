import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import StdoutReporter, { failedPaths, markdownTable } from '../src/perf/reporter.ts';

interface Step {
  readonly title: string;
  readonly category: string;
  readonly error?: { readonly message: string };
  readonly steps: readonly Step[];
}

const passed = (title: string, steps: readonly Step[] = []): Step => ({
  title,
  category: 'expect',
  steps,
});

const failed = (title: string, message: string, steps: readonly Step[] = []): Step =>
  Object.assign(passed(title, steps), { error: { message: `${message}\nstack` } });

await test('a failed test lists the path to every failed assertion, nested ones included', () => {
  const steps = [
    failed('outer', 'outer failure', [failed('inner', 'deep failure'), passed('passes')]),
    Object.assign(failed('hook', 'not an assertion'), { category: 'hook' }),
    failed('sibling', 'last failure'),
  ];
  assert.deepEqual(failedPaths(steps), [
    '  outer: outer failure',
    '  outer › inner: deep failure',
    '  sibling: last failure',
  ]);
});

await test('a deep chain of steps is walked with one shared path', () => {
  const depth = 2000;
  const titles = Array.from({ length: depth }, (_unused, index) => `s${String(index)}`);
  let chain: readonly Step[] = [];
  for (const title of titles.toReversed()) {
    chain = [failed(title, 'fails', chain)];
  }
  const paths = failedPaths(chain);
  assert.equal(paths.length, depth);
  assert.equal(paths.at(-1), `  ${titles.join(' › ')}: fails`);
});

await test('a Markdown table escapes the pipes in its cells', () => {
  assert.deepEqual(
    markdownTable([
      ['Step', 'LCP'],
      ['sign in | 2,000 notes', '812'],
    ]),
    ['| Step | LCP |', '| --- | --- |', String.raw`| sign in \| 2,000 notes | 812 |`],
  );
});

/** A failed test as the reporter is handed one: its title path, and a soft assertion failed. */
const failedTest = {
  titlePath: (): string[] => ['', 'astronotes', 'journeys.spec.ts', 'signs in at 2,000 notes'],
  location: { file: '/repo/journeys.spec.ts' },
  parent: { project: (): undefined => undefined },
  outcome: (): string => 'unexpected',
};

await test('in GitHub Actions the failed assertions reach the run’s summary page', async () => {
  await using folder = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-summary-'));
  const summary = path.join(folder.path, 'summary.md');
  process.env['GITHUB_STEP_SUMMARY'] = summary;
  const { log } = console;
  console.log = (): void => undefined;
  try {
    const reporter = new StdoutReporter();
    const suite = { allTests: (): (typeof failedTest)[] => [failedTest] };
    // The fakes hold only what the reporter reads of Playwright's config, suite, test and result.
    Reflect.apply(reporter.onBegin.bind(reporter), undefined, [
      { projects: [], rootDir: '/repo' },
      suite,
    ]);
    const result = {
      status: 'failed',
      attachments: [],
      steps: [failed('LCP', 'over budget')],
      duration: 1000,
      workerIndex: 0,
    };
    Reflect.apply(reporter.onTestEnd.bind(reporter), undefined, [failedTest, result]);
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 0 });
  } finally {
    console.log = log;
    Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY');
  }
  assert.equal(
    await readFile(summary, 'utf8'),
    '- ✘  › astronotes › journeys.spec.ts › signs in at 2,000 notes\n  - LCP: over budget\n',
  );
});

await test('outside GitHub Actions, or with nothing to say, no summary is written', async () => {
  await using folder = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-summary-'));
  const summary = path.join(folder.path, 'summary.md');
  const ended = { status: 'passed', startTime: new Date(), duration: 0 } as const;
  const { log } = console;
  console.log = (): void => undefined;
  try {
    await new StdoutReporter().onEnd(ended);
    process.env['GITHUB_STEP_SUMMARY'] = summary;
    await new StdoutReporter().onEnd(ended);
  } finally {
    console.log = log;
    Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY');
  }
  await assert.rejects(readFile(summary, 'utf8'), { code: 'ENOENT' });
});
