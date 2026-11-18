// A CPU gate in this process, and a run joined to it as a test's worker joins its run's.
import assert from 'node:assert/strict';

import { CPU_GATE_ENV, type TestTimeout } from '../src/stack/control.ts';
import { joinGate } from '../src/stack/gate-member.ts';
import { serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';

/** A gate of `slots` in this process, on a port of its own. */
export const gateOf = async (slots: number): Promise<number> => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, slots), undefined);
  return port;
};

/** A test's timeout as a widening test sees it, with every timeout it is moved to. */
export const timeoutOf = (timeout: number): TestTimeout & { readonly moved: number[] } => {
  const moved: number[] = [];
  return {
    timeout,
    moved,
    setTimeout: (ms) => {
      moved.push(ms);
    },
  };
};

/** Runs `work` as a test of a run in a gate of two slots, as the global setup leaves one. */
export const inRun = async (work: (turns: string) => Promise<void>): Promise<void> => {
  const run = await joinGate(await gateOf(2));
  process.env[CPU_GATE_ENV] = run.turns;
  try {
    await work(run.turns);
  } finally {
    Reflect.deleteProperty(process.env, CPU_GATE_ENV);
    run.leave();
  }
};
