// The config hands the reporter the file every setup project runs, and holds Playwright's own
// slow-file report to a bound no file reaches. Its repo of one site is set before anything reads it.
import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isObject } from '../src/unknown.ts';

await using repo = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-slow-'));
await mkdir(path.join(repo.path, 'site', 'tests'), { recursive: true });
await writeFile(path.join(repo.path, 'site', 'astro.config.mjs'), '');
await writeFile(path.join(repo.path, 'site', 'tests', 'a.spec.ts'), '');
// The repo the config reads is fixed as its module loads.
process.env['KIT_ROOT'] = repo.path;
const { defineTests } = await import('../src/config.ts');

await test("Playwright's own report names no file, and the reporter is handed each setup's", () => {
  const { reportSlowTests, reporter = [], projects = [] } = defineTests();
  const given = (Array.isArray(reporter) ? reporter : []).flatMap((description) => {
    const options: unknown = description[1];
    return isObject(options) && 'setupFile' in options ? [options['setupFile']] : [];
  });
  const setups = projects.filter(({ name = '' }) => name.endsWith('/setup'));
  assert.equal((reportSlowTests ?? { threshold: 0 }).threshold, Number.POSITIVE_INFINITY);
  assert.equal(given.length, 1);
  // The site's own setup, on every platform, beside the Linux image's where macOS has one.
  assert.ok(setups.some(({ name }) => name === `${path.basename(repo.path)}/setup`));
  for (const { testMatch } of setups) {
    assert.equal(testMatch, given[0]);
  }
});
