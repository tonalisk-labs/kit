import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { run, runShown } from '../src/stack/process.ts';

await test('a failed command reports its last 60 lines of output, in order', async () => {
  const { signal } = new AbortController();
  await assert.rejects(run('sh', ['-c', 'seq 1 20000; exit 3'], { signal }), (error: Error) => {
    const lines = error.message.split('\n');
    assert.equal(lines[0], 'sh exited with 3:');
    assert.deepEqual(
      lines.slice(1),
      Array.from({ length: 60 }, (_unused, index) => String(19_941 + index)),
    );
    return true;
  });
});

await test('a shown command resolves with its exit status', async () => {
  const { signal } = new AbortController();
  assert.equal(await runShown('sh', ['-c', 'echo shown; exit 4'], { signal }), 4);
  assert.equal(await runShown('true', [], { signal }), 0);
});

await test('a stop ends a shown command and its whole group', async () => {
  const stop = new AbortController();
  // A length no other process sleeps for, so the group's own sleeps can be looked for after.
  const marker = String(30 + Math.random());
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-process-'));
  const watcher = watch(folder);
  try {
    const started = once(watcher, 'change');
    const script = `sleep ${marker} & sleep ${marker} & : > ${folder}/started; wait`;
    const running = runShown('sh', ['-c', script], { signal: stop.signal });
    await started;
    stop.abort('SIGTERM');
    assert.notEqual(await running, 0);
    const left = await runShown('pgrep', ['-f', `sleep ${marker}`], {
      signal: new AbortController().signal,
    });
    assert.equal(left, 1, 'no sleep of the group is left running');
  } finally {
    watcher.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
