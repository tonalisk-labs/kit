// A run's process ends once it lets go of the CPU gate, a turn refused as it left included: no hold
// it opened is left to keep the process running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';

import { serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';

/** A module of the stack, as an import in a script of its own names it. */
const stack = (name: string): string =>
  JSON.stringify(path.resolve(import.meta.dirname, '../src/stack', name));

const SERVED = JSON.stringify('http.server.request.start');

/** Two runs of their own, one holding the one slot while the other leaves with a turn its turns
 *  server has, which is refused; then both let go, and nothing either opened is left. */
const LEAVER = `
const { subscribe, unsubscribe } = await import('node:diagnostics_channel');
const { joinGate } = await import(${stack('gate-member.ts')});
const { holdTurn } = await import(${stack('control.ts')});
const port = Number(process.argv[1]);
const [holder, leaving] = await Promise.all([joinGate(port), joinGate(port)]);
const held = await holdTurn(holder.turns);
const served = new Promise((resolve) => {
  const heard = () => {
    unsubscribe(${SERVED}, heard);
    resolve();
  };
  subscribe(${SERVED}, heard);
});
const waiting = holdTurn(leaving.turns).then(() => 'granted', (error) => error.message);
await served;
leaving.leave();
process.stdout.write(await waiting);
held();
holder.leave();
`;

await test('a run that leaves with a turn refused, and lets go of the rest, lets its process end', async () => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, 1), undefined);
  // A process left held would never end: the bound fails it instead of the whole file.
  const leaver = spawn(process.execPath, ['--input-type=module', '--eval', LEAVER, String(port)], {
    signal: AbortSignal.timeout(60_000),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const said: Buffer[] = [];
  leaver.stdout.on('data', (chunk: Buffer) => {
    said.push(chunk);
  });
  await once(leaver, 'exit');
  assert.match(Buffer.concat(said).toString(), /refused a turn/u);
  assert.equal(leaver.exitCode, 0);
});
