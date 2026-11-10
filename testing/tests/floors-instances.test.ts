// A module the tests load more than once counts once in a workspace's coverage: a line any load
// ran has run, and its branches are those of the load that ran most of them.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type FileCoverage, measuredOnce } from '../src/floors/instances.ts';
import { run } from '../src/stack/process.ts';

const RUNNER = path.resolve(import.meta.dirname, '../src/floors/node.ts');

/** A page whose two ways out each run on one load only. */
const PAGE = [
  'export const show = (signedIn) => {',
  '  if (signedIn) {',
  "    return 'library';",
  '  }',
  "  return 'sign-in';",
  '};',
].join('\n');

/** Two tests, each loading the page afresh, as a test of a page load does. */
const LOADS = [
  "import { test } from 'node:test';",
  "test('signed in', async () => {",
  "  const page = await import('./page.mjs?load=1');",
  '  page.show(true);',
  '});',
  "test('signed out', async () => {",
  "  const page = await import('./page.mjs?load=2');",
  '  page.show(false);',
  '});',
].join('\n');

/** The runner's environment, less the test runner's own context: the fixture runs on its own. */
const ownEnvironment = (): NodeJS.ProcessEnv =>
  Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    { npm_package_name: 'fixture' },
  );

await test('a page each test loads afresh is covered whole, its lines counted once', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'floors-instances-'));
  await writeFile(path.join(folder, 'coverage.json'), '{ "lines": 100, "branches": 66 }');
  await writeFile(path.join(folder, 'page.mjs'), PAGE);
  await writeFile(path.join(folder, 'loads.test.mjs'), LOADS);
  const said = await run(process.execPath, [RUNNER], {
    cwd: folder,
    env: ownEnvironment(),
    signal: new AbortController().signal,
  });
  assert.ok(said.includes('fixture: lines 100.0% of 6, floor 100%'), said);
  // Each load reports the page's two functions run and the way out it did not take.
  assert.ok(said.includes('fixture: branches 66.7% of 3, floor 66%'), said);
  await rm(folder, { recursive: true });
});

/** A load's coverage: `ran` of its `lines` run, `ignored` more that coverage is told to ignore,
 *  and its branches, `covered` of `count` run. */
const load = (
  file: string,
  {
    lines,
    ran,
    ignored = 0,
    branches: [covered, count],
  }: { lines: number; ran: readonly number[]; ignored?: number; branches: [number, number] },
): FileCoverage => ({
  path: file,
  totalLineCount: lines + ignored,
  totalBranchCount: count,
  coveredBranchCount: covered,
  lines: [...Array.from({ length: lines }).keys()].map((index) => ({
    line: index + 1,
    count: ran.includes(index + 1) ? 1 : 0,
  })),
});

await test('a line any load ran has run; a file’s branches are those of the load that ran most', () => {
  const measured = measuredOnce([
    load('/w/page.ts', { lines: 4, ran: [1, 2], ignored: 2, branches: [1, 3] }),
    load('/w/page.ts', { lines: 4, ran: [1, 3], ignored: 2, branches: [2, 3] }),
    // A load in which a function never ran reports no branch inside it.
    load('/w/page.ts', { lines: 4, ran: [1], ignored: 2, branches: [1, 2] }),
    load('/w/other.ts', { lines: 2, ran: [2], branches: [0, 1] }),
  ]);
  assert.deepEqual(measured, {
    lines: { covered: 6, count: 8 },
    branches: { covered: 2, count: 4 },
  });
});

await test('a file loaded once counts as Node counts it', () => {
  const measured = measuredOnce([
    load('/w/once.ts', { lines: 3, ran: [], ignored: 1, branches: [0, 2] }),
  ]);
  assert.deepEqual(measured, {
    lines: { covered: 1, count: 4 },
    branches: { covered: 0, count: 2 },
  });
});

await test('no file loaded measures nothing', () => {
  assert.deepEqual(measuredOnce([]), {
    lines: { covered: 0, count: 0 },
    branches: { covered: 0, count: 0 },
  });
});
