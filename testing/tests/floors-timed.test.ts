// A workspace's timed tests run after the rest and on their own, and stay out of the coverage
// pass: a fixture workspace's tests write down when each ran.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PHASE_ENV, phaseOf, testFiles } from '../src/floors/timed.ts';
import { serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';
import { run } from '../src/stack/process.ts';

const RUNNER = path.resolve(import.meta.dirname, '../src/floors/node.ts');

/** The CPU gate the fixture's timed tests hold whole, served here rather than the machine's. */
const GATE = await freePort();
assert.notEqual(await serveGate(GATE, 2), undefined);

/** A test file that writes `name` down, with what had been written before it if `looks`. */
const writer = (log: string, name: string, looks = false): string =>
  [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `test('${name}', () => {`,
    looks
      ? `  appendFileSync(${JSON.stringify(log)}, '${name} after ' + readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').toSorted().join(' ') + '\\n');`
      : `  appendFileSync(${JSON.stringify(log)}, '${name}\\n');`,
    '});',
  ].join('\n');

/** A workspace of two tests and one timed test, its floors at zero. */
const workspace = async (): Promise<{ folder: string; log: string }> => {
  const folder = await mkdtemp(path.join(tmpdir(), 'floors-timed-'));
  const log = path.join(folder, 'ran.log');
  await writeFile(log, '');
  await writeFile(path.join(folder, 'coverage.json'), '{ "lines": 0, "branches": 0 }');
  await writeFile(path.join(folder, 'one.test.mjs'), writer(log, 'one'));
  await writeFile(path.join(folder, 'two.test.mjs'), writer(log, 'two'));
  await writeFile(path.join(folder, 'slow.perf.test.mjs'), writer(log, 'timed', true));
  return { folder, log };
};

await test('the timed files are found apart from the rest, as node --test would find them', async () => {
  const { folder } = await workspace();
  const { parallel, timed } = await testFiles(folder, []);
  assert.deepEqual(
    [parallel.map((file) => path.basename(file)), timed.map((file) => path.basename(file))],
    [['one.test.mjs', 'two.test.mjs'], ['slow.perf.test.mjs']],
  );
  await rm(folder, { recursive: true });
});

/** The runner's environment, less the test runner's own context and the phase this run was
 *  given: the fixture runs on its own, in the phase its test names. */
const ownEnvironment = (): NodeJS.ProcessEnv =>
  Object.assign(
    Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'NODE_TEST_CONTEXT' && key !== PHASE_ENV,
      ),
    ),
    { npm_package_name: 'fixture', KIT_CPU_GATE_PORT: String(GATE) },
  );

const byName = (one: string, other: string): number => one.localeCompare(other);

await test('a timed test runs once the rest are done, alone, and not again for coverage', async () => {
  const { folder, log } = await workspace();
  await run(process.execPath, [RUNNER], {
    cwd: folder,
    env: ownEnvironment(),
    signal: new AbortController().signal,
  });
  const written = await readFile(log, 'utf8');
  const [first = '', second = '', timed, ...coverage] = written.trim().split('\n');
  assert.deepEqual(
    [[first, second].toSorted(byName), timed, coverage.toSorted(byName)],
    [['one', 'two'], 'timed after one two', ['one', 'two']],
  );
  await rm(folder, { recursive: true });
});

await test('patterns given name the files; with no timed test, a failure ends the run unmeasured', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'floors-timed-'));
  await writeFile(path.join(folder, 'coverage.json'), '{ "lines": 100, "branches": 100 }');
  await writeFile(
    path.join(folder, 'fails.test.mjs'),
    "import { test } from 'node:test';\ntest('fails', () => { throw new Error('no'); });",
  );
  await writeFile(path.join(folder, 'skipped.test.mjs'), '');
  const { parallel, timed } = await testFiles(folder, ['fails.test.mjs']);
  assert.deepEqual([parallel.map((file) => path.basename(file)), timed], [['fails.test.mjs'], []]);
  const environment = ownEnvironment();
  delete environment['npm_package_name'];
  const said = await run(process.execPath, [RUNNER, 'fails.test.mjs'], {
    cwd: folder,
    env: environment,
    signal: new AbortController().signal,
  }).catch(String);
  assert.ok(said.includes('exited with 1'), said);
  assert.ok(!said.includes('below its floor'), 'a failing run is not measured');
  await rm(folder, { recursive: true });
});

await test('a run names its phase, both when unset, and any other word is refused', () => {
  assert.deepEqual(
    [undefined, '', 'untimed', 'timed'].map((value) => phaseOf(value)),
    ['both', 'both', 'untimed', 'timed'],
  );
  assert.throws(() => phaseOf('perf'), /KIT_TEST_PHASE is untimed, timed or unset, not perf/u);
});

/** What a run of the fixture workspace in `phase` wrote down, and what it said. */
const ranIn = async (phase: string): Promise<{ readonly ran: string[]; readonly said: string }> => {
  const { folder, log } = await workspace();
  const said = await run(process.execPath, [RUNNER], {
    cwd: folder,
    env: Object.assign(ownEnvironment(), { [PHASE_ENV]: phase }),
    signal: new AbortController().signal,
  });
  const written = await readFile(log, 'utf8');
  const ran = written.trim().split('\n').toSorted(byName);
  await rm(folder, { recursive: true });
  return { ran, said };
};

await test('the untimed phase runs the rest and their coverage, and names the timed files it left', async () => {
  const { ran, said } = await ranIn('untimed');
  assert.deepEqual(ran, ['one', 'one', 'two', 'two']);
  assert.ok(
    said.includes('Timed test files left to their own run (KIT_TEST_PHASE=timed): 1'),
    said,
  );
});

await test('the timed phase runs the timed files alone, with nothing before them and no coverage', async () => {
  const { ran, said } = await ranIn('timed');
  assert.deepEqual(ran, ['timed after']);
  assert.ok(said.includes('Timed test files run alone (KIT_TEST_PHASE=timed): 1'), said);
});
