import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import StdoutReporter from '../src/perf/reporter.ts';
import { SlowFiles } from '../src/perf/slow-files.ts';

const MINUTE = 60_000;

const ADVICE =
  '  Consider running tests from slow files in parallel. See: https://playwright.dev/docs/test-parallel';

const plain = (lines: readonly string[]): string[] =>
  lines.map((line) => stripVTControlCharacters(line));

await test('a file one worker ran past 5 minutes is named as Playwright names it', () => {
  const files = new SlowFiles('/repo');
  files.add('site/01-desktop', '/repo/tests/long.spec.ts', {
    duration: 3 * MINUTE,
    workerIndex: 0,
  });
  files.add('site/01-desktop', '/repo/tests/long.spec.ts', {
    duration: 3 * MINUTE,
    workerIndex: 0,
  });
  files.add('site/01-desktop', '/repo/tests/at-bound.spec.ts', {
    duration: 5 * MINUTE,
    workerIndex: 1,
  });
  assert.deepEqual(plain(files.report()), [
    '  Slow test file: [site/01-desktop] › tests/long.spec.ts (6.0m)',
    ADVICE,
  ]);
});

await test('a file its tests spread over two workers is not slow, nor a quick one', () => {
  const files = new SlowFiles('/repo');
  files.add('site/01-desktop', '/repo/tests/spread.spec.ts', {
    duration: 4 * MINUTE,
    workerIndex: 0,
  });
  files.add('site/01-desktop', '/repo/tests/spread.spec.ts', {
    duration: 4 * MINUTE,
    workerIndex: 1,
  });
  files.add('site/01-desktop', '/repo/tests/quick.spec.ts', { duration: 1000, workerIndex: 2 });
  assert.deepEqual(files.report(), []);
});

await test('the same file under two projects is two files, and only the 5 slowest are named', () => {
  const files = new SlowFiles('/repo');
  for (const minutes of [6, 9, 7, 11, 8, 10]) {
    files.add(`site/${String(minutes)}`, '/repo/tests/a.spec.ts', {
      duration: minutes * MINUTE,
      workerIndex: minutes,
    });
  }
  assert.deepEqual(
    plain(files.report()).map((line) =>
      line.replace(/^ {2}Slow test file: \[site\/(?<minutes>\d+)\].*$/u, '$<minutes>'),
    ),
    ['11', '10', '9', '8', '7', ADVICE],
  );
});

const testIn = (file: string, project: string): object => ({
  location: { file },
  titlePath: (): string[] => ['', project, file, 'a test'],
});

await test('the reporter names a slow file but leaves out the setup file it was given', async () => {
  const printed: string[] = [];
  const { log } = console;
  console.log = (line: string): void => {
    printed.push(line);
  };
  try {
    const reporter = new StdoutReporter({ setupFile: '/repo/kit/stack.setup.ts' });
    const suite = { allTests: (): object[] => [] };
    Reflect.apply(reporter.onBegin.bind(reporter), undefined, [
      { projects: [], rootDir: '/repo' },
      suite,
    ]);
    const result = { status: 'passed', attachments: [], steps: [], workerIndex: 0 };
    const long = Object.assign(result, { duration: 9 * MINUTE });
    for (const ran of [
      testIn('/repo/kit/stack.setup.ts', 'site/setup'),
      testIn('/repo/tests/journeys.spec.ts', 'site/visual-01'),
    ]) {
      Reflect.apply(reporter.onTestEnd.bind(reporter), undefined, [ran, long]);
    }
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 0 });
  } finally {
    console.log = log;
  }
  assert.deepEqual(plain(printed.join('\n').split('\n')), [
    '  Slow test file: [site/visual-01] › tests/journeys.spec.ts (9.0m)',
    ADVICE,
  ]);
});
