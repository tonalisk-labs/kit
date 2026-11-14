// No project's tests are looked for where a build writes or packages are installed: a check's
// tasks run side by side, so a coverage build may remove a folder under `target/` as a listing
// walks it. A repo of two targets, one with no tests of its own, holds a build's output and
// installed packages at its root, and one target's own packages beside it.
import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { MEASURE_ENV } from '../src/stack/control.ts';

await using repo = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-dirs-'));

const made = async (file: string, content = ''): Promise<void> => {
  const at = path.join(repo.path, file);
  await mkdir(path.dirname(at), { recursive: true });
  await writeFile(at, content);
};

await made('site/astro.config.mjs');
await made('site/tests/journeys/a.spec.ts');
await made('site/tests/measure/b.spec.ts');
await made('site/node_modules/package/index.js');
await made('docs/astro.config.mjs');
await made('target/llvm-cov-target/debug/deps/a.rmeta');
await made('node_modules/package/index.js');

// The repo the config reads is fixed as its module loads, and holds a package.json as a repo does.
await writeFile(path.join(repo.path, 'package.json'), '{}');
process.env['KIT_ROOT'] = repo.path;
const { defineTests } = await import('../src/config.ts');

const UNWALKED: ReadonlySet<string> = new Set(['target', 'node_modules']);

/** The folders named as a build's output or installed packages anywhere under `folder`. */
const unwalkedIn = async (folder: string): Promise<string[]> => {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(
    (error: unknown) => {
      // A target with no tests of its own has no folder to look in.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory() && UNWALKED.has(entry.name))
    .map((entry) => path.relative(repo.path, path.join(entry.parentPath, entry.name)));
};

/** Each project's test folder, and the folders in it no listing may walk. */
const walked = async (): Promise<Record<string, string[]>> => {
  const { projects = [] } = defineTests();
  const found = await Promise.all(
    projects.map(async ({ name = '', testDir = repo.path }): Promise<[string, string[]]> => [
      name,
      await unwalkedIn(testDir),
    ]),
  );
  return Object.fromEntries(found.filter(([, folders]) => folders.length > 0));
};

await test("no project's tests are looked for in a build's output or installed packages", async () => {
  assert.deepEqual(await walked(), {});
});

await test('neither are measured journeys', async () => {
  process.env[MEASURE_ENV] = '1';
  try {
    assert.deepEqual(await walked(), {});
  } finally {
    Reflect.deleteProperty(process.env, MEASURE_ENV);
  }
});
