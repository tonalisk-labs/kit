import assert from 'node:assert/strict';
import { test } from 'node:test';

import { didNotRun, type ProjectTally, unrunReport, workerNamed } from '../src/perf/unrun.ts';

const tally = (dependencies: readonly string[], failed = 0, unrun = 0): ProjectTally => ({
  dependencies,
  failed,
  unrun,
});

const FORCE_KILLED =
  'Error: worker-14 process did not exit within 300000ms after stop, force-killed it';

await test('a run where every test ran reports nothing', () => {
  const projects = new Map([
    ['site/setup', tally([])],
    ['site/01', tally(['site/setup'])],
  ]);
  assert.deepEqual(unrunReport(projects, [FORCE_KILLED]), []);
});

await test('rows behind a passed guard name the worker error that dropped them', () => {
  const projects = new Map([
    ['site/setup', tally([])],
    ['site/guard', tally(['site/setup'])],
    ['site/01', tally(['site/setup', 'site/guard'], 0, 101)],
    ['site/13', tally(['site/setup', 'site/guard'], 0, 1)],
  ]);
  assert.deepEqual(unrunReport(projects, [FORCE_KILLED]), [
    'Did not run: 102 tests in 2 projects, which fails the run.',
    `  site/01: 101 tests; its dependencies passed, but after a worker error Playwright counts no dependency as passed: ${FORCE_KILLED}`,
    `  site/13: 1 test; its dependencies passed, but after a worker error Playwright counts no dependency as passed: ${FORCE_KILLED}`,
  ]);
});

await test('a failed or unrun dependency is named before any worker error', () => {
  const projects = new Map([
    ['site/setup', tally([])],
    ['site/guard', tally(['site/setup'], 1)],
    ['site/01', tally(['site/guard'], 0, 3)],
    ['site/02', tally(['site/01'], 0, 2)],
    ['other/01', tally([], 1, 4)],
    ['lone/01', tally([], 0, 5)],
  ]);
  assert.deepEqual(unrunReport(projects, []), [
    'Did not run: 14 tests in 4 projects, which fails the run.',
    '  site/01: 3 tests; its dependency site/guard failed',
    '  site/02: 2 tests; its dependency site/01 did not run',
    '  other/01: 4 tests; a test of its own failed first (a serial group or --max-failures)',
    '  lone/01: 5 tests; its dependencies passed, yet Playwright queued none of its tests',
  ]);
});

const ran = (
  outcome: 'skipped' | 'expected',
  statuses: readonly ('skipped' | 'interrupted' | 'passed')[],
  expectedStatus: 'skipped' | 'passed' = 'passed',
): boolean =>
  didNotRun({
    outcome: () => outcome,
    results: statuses.map((status) => ({ status })),
    expectedStatus,
  });

await test("did not run is Playwright's own count: never interrupted, nor meant to skip", () => {
  assert.equal(ran('skipped', []), true);
  assert.equal(ran('skipped', ['skipped']), true);
  assert.equal(ran('skipped', ['skipped'], 'skipped'), false);
  assert.equal(ran('skipped', ['interrupted']), false);
  assert.equal(ran('expected', ['passed']), false);
});

await test('a runner error names its worker by index, if it names one', () => {
  assert.equal(workerNamed(FORCE_KILLED), 14);
  assert.equal(workerNamed('Error: something else'), undefined);
});
