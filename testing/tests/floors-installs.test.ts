// A workspace's coverage counts its own code only: what it installs in its own node_modules, as a
// workspace beside a different version of a dependency does, stays out of the floors.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { run } from '../src/stack/process.ts';

const RUNNER = path.resolve(import.meta.dirname, '../src/floors/node.ts');

/** The runner's environment, less the test runner's own context: the fixture runs on its own. */
const ownEnvironment = (): NodeJS.ProcessEnv =>
  Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
    { npm_package_name: 'fixture' },
  );

/** A dependency of many lines and branches, of which its importer calls one function. */
const dependency = (): string =>
  [
    'export const used = () => 1;',
    ...Array.from({ length: 50 }, (_unused, index) =>
      [
        `export function unused${String(index)}(value) {`,
        `  if (value > ${String(index)}) {`,
        `    return value - ${String(index)};`,
        '  }',
        `  return ${String(index)};`,
        '}',
      ].join('\n'),
    ),
  ].join('\n');

await test('a package in the workspace’s own node_modules is left out of its coverage', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'floors-installs-'));
  await writeFile(path.join(folder, 'coverage.json'), '{ "lines": 100, "branches": 100 }');
  await mkdir(path.join(folder, 'node_modules', 'dependency'), { recursive: true });
  await writeFile(path.join(folder, 'node_modules', 'dependency', 'index.mjs'), dependency());
  await writeFile(
    path.join(folder, 'own.mjs'),
    "import { used } from './node_modules/dependency/index.mjs';\nexport const own = () => used() + 1;\n",
  );
  await writeFile(
    path.join(folder, 'own.test.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "import { own } from './own.mjs';",
      "test('own', () => { assert.equal(own(), 2); });",
    ].join('\n'),
  );
  const said = await run(process.execPath, [RUNNER], {
    cwd: folder,
    env: ownEnvironment(),
    signal: new AbortController().signal,
  }).catch(String);
  assert.ok(!said.includes('below its floor'), said);
  assert.ok(!said.includes('exited with'), said);
  await rm(folder, { recursive: true });
});
