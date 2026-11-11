// Where a stack builds its target's site: in the target's own `.astro`, a directory of its own
// each time, and never in the system's temp, whose old files macOS deletes nightly. And where
// it serves it: from a process of its own, which answers whatever the stack's own process does.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PREVIEW_READY, previewPortOf, siteDirIn, startPreview } from '../src/stack/frontend.ts';

/** The kit's own root, whose Astro serves the preview as a target's would. */
const KIT = fileURLToPath(new URL('../..', import.meta.url));

/** How long the blocked test waits for the other process's fetch: only the bound on a child that
 *  could hang, which a site served in this process would leave unanswered. */
const FETCH_BOUND_MS = 60_000;

await test('each stack builds its site in a directory of its own in the target’s .astro', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-target-'));
  try {
    const [one, two] = [await siteDirIn(root), await siteDirIn(root)];
    for (const dir of [one, two]) {
      assert.equal(path.dirname(dir), path.join(root, '.astro'));
      assert.match(path.basename(dir), /^site-/u);
      assert.ok(statSync(dir).isDirectory());
    }
    assert.notEqual(one, two);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('the site is served from a process of its own, so it answers while this one is blocked', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'kit-preview-'));
  writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><title>Served</title>');
  const preview = await startPreview(KIT, outDir, new AbortController().signal);
  try {
    // This process's loop is held until the fetch in another process ends.
    const fetched = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const answer = await fetch('http://127.0.0.1:${String(preview.port)}/');
         process.exit(answer.status === 200 && (await answer.text()).includes('Served') ? 0 : 1);`,
      ],
      { timeout: FETCH_BOUND_MS },
    );
    assert.equal(fetched.status, 0, String(fetched.stderr));
  } finally {
    await preview.stop();
    rmSync(outDir, { recursive: true, force: true });
  }
});

await test('the preview’s port is a whole number from 1 to 65535, or a failure quoting its line', () => {
  assert.equal(previewPortOf(`${PREVIEW_READY}4321`), 4321);
  assert.equal(previewPortOf(`${PREVIEW_READY}65535`), 65_535);
  for (const written of ['0', '65536', '012', ' 80', '80 ', '-1', '4e3', '12a', '']) {
    const line = `${PREVIEW_READY}${written}`;
    assert.throws(() => previewPortOf(line), {
      message: `the preview named no port it could listen on: ${line}`,
    });
  }
});

/** A preview's process, its stdin ended once it serves: the exit code it ends with. Vite ends a
 *  preview with its stdin only where CI isn't "true", so each test sets CI one way. */
const endedWithStdin = async (ci: Readonly<Record<string, string>>): Promise<number | null> => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'kit-preview-'));
  writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><title>Served</title>');
  const others = Object.entries(process.env).filter(([name]) => name !== 'CI');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../src/stack/preview-child.ts', import.meta.url)), KIT, outDir],
    { stdio: ['pipe', 'pipe', 'inherit'], env: Object.assign(Object.fromEntries(others), ci) },
  );
  try {
    const ready = new Promise<void>((resolve) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith(PREVIEW_READY)) {
          resolve();
        }
      });
    });
    await ready;
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
    });
    child.stdin.end();
    return await exited;
  } finally {
    child.kill();
    rmSync(outDir, { recursive: true, force: true });
  }
};

await test('the preview’s process ends with its stdin, as when the stack that holds it is killed', async () => {
  assert.equal(await endedWithStdin({}), 0);
});

await test('the preview’s process ends with its stdin just the same where CI is set', async () => {
  assert.equal(await endedWithStdin({ CI: 'true' }), 0);
});
