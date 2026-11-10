// A failed test's trace, error context and screenshot outlast the run that made them, in the
// folder its report names, and a passing test leaves nothing behind.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { OUTPUT_ENV, outputOf } from '../src/output.ts';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = require.resolve('@playwright/test');
const CLI = require.resolve('@playwright/test/cli');
const OUTPUT = fileURLToPath(import.meta.resolve('../src/output.ts'));

const configOf = (
  repo: string,
): string => `import { defineConfig } from ${JSON.stringify(PLAYWRIGHT)};
import { outputOf } from ${JSON.stringify(OUTPUT)};
export default defineConfig({
  ...outputOf(${JSON.stringify(repo)}),
  testDir: '.',
  reporter: 'list',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
`;

const SPEC = `import { expect, test } from ${JSON.stringify(PLAYWRIGHT)};
test('passes', async ({ page }) => {
  await page.setContent('<p>kept</p>');
  await expect(page.locator('p')).toHaveText('kept');
});
test('fails', async ({ page }) => {
  await page.setContent('<p>kept</p>');
  await expect(page.locator('p')).toHaveText('gone', { timeout: 1 });
});
`;

/** Runs the repo's suite to its end, the exit code and what the report printed. */
const ran = async (repo: string): Promise<{ code: number; report: string }> =>
  new Promise((resolve) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== OUTPUT_ENV && name !== 'CI'),
    );
    execFile(process.execPath, [CLI, 'test'], { cwd: repo, env }, (error, stdout) => {
      resolve({ code: error === null ? 0 : Number(error.code), report: stdout });
    });
  });

await test("a failed test's trace outlasts its run, in the folder the report names, and a passing test's output goes", async () => {
  await using repo = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-output-'));
  await writeFile(path.join(repo.path, 'playwright.config.ts'), configOf(repo.path));
  await writeFile(path.join(repo.path, 'kept.spec.ts'), SPEC);
  const { code, report } = await ran(repo.path);
  assert.equal(code, 1, report);
  const results = path.join(repo.path, 'test-results');
  const files = await readdir(results, { recursive: true });
  const traces = files.filter((file) => path.basename(file) === 'trace.zip');
  assert.equal(traces.length, 1, files.join('\n'));
  const [trace = ''] = traces;
  const failed = path.dirname(trace);
  assert.match(failed, /fails/u);
  assert.deepEqual(
    files
      .filter((file) => file.startsWith(`${failed}${path.sep}`))
      .map((file) => path.basename(file))
      .toSorted(),
    ['error-context.md', 'test-failed-1.png', 'trace.zip'],
  );
  assert.deepEqual(
    files.filter((file) => file.includes('passes')),
    [],
  );
  assert.ok(report.includes(path.join('test-results', trace)), report);
});

await test("the folder is the repo's test-results, or where its variable says, from the repo", () => {
  const repo = path.resolve('/repo');
  Reflect.deleteProperty(process.env, OUTPUT_ENV);
  assert.deepEqual(outputOf(repo), {
    outputDir: path.join(repo, 'test-results'),
    preserveOutput: 'failures-only',
  });
  process.env[OUTPUT_ENV] = 'kept';
  assert.equal(outputOf(repo).outputDir, path.join(repo, 'kept'));
  process.env[OUTPUT_ENV] = path.resolve('/elsewhere');
  assert.equal(outputOf(repo).outputDir, path.resolve('/elsewhere'));
});
