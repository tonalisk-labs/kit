import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { reportStopped, stopSignal, stoppedStatus } from '../src/stop.ts';

await test('a stop exits as a shell reports a process the signal ended', () => {
  assert.equal(stoppedStatus('SIGHUP'), 129);
  assert.equal(stoppedStatus('SIGINT'), 130);
  assert.equal(stoppedStatus('SIGTERM'), 143);
});

await test('the first SIGHUP, SIGINT or SIGTERM aborts the stop signal, which keeps its reason', () => {
  const listeners = new Map<string, () => void>();
  const stop = stopSignal({
    on: (name, listener) => listeners.set(name, listener),
  });
  const raise = (name: string): void => {
    const listener = listeners.get(name);
    assert.ok(listener !== undefined, `nothing hears ${name}`);
    listener();
  };
  assert.equal(stop.aborted, false);
  raise('SIGTERM');
  raise('SIGINT');
  raise('SIGHUP');
  assert.equal(stop.aborted, true);
  assert.equal(stop.reason, 'SIGTERM');
  const hungUp = new Map<string, () => void>();
  const ended = stopSignal({ on: (name, listener) => hungUp.set(name, listener) });
  const listener = hungUp.get('SIGHUP');
  assert.ok(listener !== undefined, 'nothing hears SIGHUP');
  listener();
  assert.equal(ended.reason, 'SIGHUP');
});

/** A script that works until it's stopped, then cleans up into the file it's given. Its work is a
 *  timer, which holds the event loop open as a real script's work does: a signal's listener doesn't. */
const waitingScript = (script: string): string => `import { writeFileSync } from 'node:fs';
import { runScript } from ${JSON.stringify(script)};
await runScript('hung-up', async (stop) => {
  const working = setInterval(() => undefined, 60_000);
  try {
    await new Promise((resolve) => {
      stop.addEventListener('abort', resolve);
      process.stdout.write('waiting\\n');
    });
  } finally {
    clearInterval(working);
    writeFileSync(process.argv[2], 'cleaned up');
  }
  return 0;
});
`;

await test("a hang-up stops a script's run, whose clean-up still runs, and it exits as hung up", async () => {
  await using folder = await mkdtempDisposable(path.join(tmpdir(), 'stop-hang-up-'));
  const script = path.join(folder.path, 'waiting.mjs');
  const cleaned = path.join(folder.path, 'cleaned');
  const runner = pathToFileURL(path.join(import.meta.dirname, '../src/script.ts')).href;
  await writeFile(script, waitingScript(runner));
  const child = spawn(process.execPath, [script, cleaned], { stdio: ['ignore', 'pipe', 'pipe'] });
  const told: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    told.push(chunk.toString());
  });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  child.kill('SIGHUP');
  await exited;
  assert.equal(child.exitCode, 129);
  assert.equal(await readFile(cleaned, 'utf8'), 'cleaned up');
  assert.match(told.join(''), /hung-up: stopped by SIGHUP; no report\./u);
});

await test('a stopped run says so on stderr and exits with its signal’s status', (context) => {
  const told = context.mock.method(console, 'error', () => {
    // Counted, not printed.
  });
  const stop = new AbortController();
  stop.abort('SIGINT');
  try {
    reportStopped('a-script', stop.signal);
    assert.equal(process.exitCode, 130);
  } finally {
    process.exitCode = 0;
  }
  assert.deepEqual(
    told.mock.calls.map((call) => call.arguments),
    [['a-script: stopped by SIGINT; no report.']],
  );
});
