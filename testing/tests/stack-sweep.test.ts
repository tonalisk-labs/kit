// A stack's containers go with their run: each is labelled with the run that made it, and a run
// sweeps, before its first container, those whose run on this host is gone, as a SIGKILL leaves
// them, never one whose run still goes. The second test starts Postgres in the platform's container
// runtime, which must answer.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { leftBehind, RUN_LABEL, RUNTIME, sweepLeftBehind } from '../src/stack/containers.ts';

const POSTGRES = path.resolve(import.meta.dirname, '../src/stack/postgres.ts');

/** A run of its own: it starts Postgres through the stack, says the container, and waits. */
const HOLDER = `
const { startPostgres } = await import(${JSON.stringify(POSTGRES)});
const database = await startPostgres([{ name: 'reader' }], new AbortController().signal);
console.log(database.container);
setInterval(() => {}, 60_000);
`;

interface Holder {
  readonly run: ChildProcess;
  readonly container: string;
}

const hold = async (): Promise<Holder> => {
  const run = spawn(process.execPath, ['--input-type=module', '--eval', HOLDER], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: run.stdout });
  const said = once(lines, 'line').then(([line]: unknown[]) => String(line));
  const gave = once(run, 'exit').then(([code]: unknown[]): never => {
    throw new Error(`the run exited first, with ${String(code)}`);
  });
  return { run, container: await Promise.race([said, gave]) };
};

/** The run label of a container the runtime still has, running or not. */
const labelOf = async (id: string): Promise<string | undefined> => {
  const labelled = await RUNTIME.labelled(RUN_LABEL);
  return labelled.get(id);
};

const exists = async (id: string): Promise<boolean> => (await labelOf(id)) !== undefined;

/** When each process began, as `ps` tells it: 7 still runs, 9 is gone. */
const began = (pid: string): string => (pid === '7' ? 'Wed Oct 28 09:00:00 2026' : '');

await test('a container is left behind once its run on this host is gone, and no other', () => {
  const labelled = new Map([
    ['gone', 'this-host 9 Wed Oct 28 08:00:00 2026'],
    ['live', 'this-host 7 Wed Oct 28 09:00:00 2026'],
    ['reused', 'this-host 7 Wed Oct 28 07:00:00 2026'],
    ['elsewhere', 'other-host 9 Wed Oct 28 08:00:00 2026'],
    ['unlabelled', ''],
  ]);
  assert.deepEqual(leftBehind(labelled, began, 'this-host'), ['gone', 'reused']);
  assert.deepEqual(leftBehind(new Map(), began, 'this-host'), []);
});

await test('a killed run’s container goes with the next sweep, and a live run’s stays', async () => {
  const [killed, live] = await Promise.all([hold(), hold()]);
  try {
    const [owner, pid] = ((await labelOf(killed.container)) ?? '').split(' ');
    assert.equal(owner, hostname());
    assert.equal(pid, String(killed.run.pid));
    const ended = once(killed.run, 'exit');
    killed.run.kill('SIGKILL');
    await ended;
    assert.equal(await exists(killed.container), true, 'no exit handler ran');
    await sweepLeftBehind();
    assert.equal(await exists(killed.container), false, 'swept, its run gone');
    assert.equal(await exists(live.container), true, 'kept, its run still going');
  } finally {
    const ended = once(live.run, 'exit');
    live.run.kill('SIGKILL');
    await ended;
    await sweepLeftBehind();
  }
  assert.equal(await exists(live.container), false);
});
