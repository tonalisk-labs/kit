import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { claimPort, ephemeralFirst, SPAN } from '../src/stack/ports.ts';
import { RUN } from '../src/stack/run.ts';

// Claims made in a folder of the test's own, so no run's real claims meet them. A port another
// process listens on is passed over, so each test asserts what holds whichever port it gets.
await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-ports-'));
const folder = temporary.path;

const first = ephemeralFirst();

const GONE_RUN = `${hostname()} 999999 Thu Jan  1 00:00:00 1970`;

/** A claim on `port` by `run`, as a claim leaves it. */
const plant = (port: number, run: string): string => {
  const holder = path.join(folder, String(port), encodeURIComponent(run));
  mkdirSync(holder, { recursive: true });
  return holder;
};

await test('a claim is a port below the ones the system hands out, and its release frees it', async () => {
  const claim = await claimPort({ start: 0, folder });
  const claimed = path.join(folder, String(claim.port));
  try {
    assert.ok(claim.port >= first - SPAN && claim.port < first, String(claim.port));
    assert.deepEqual(readdirSync(claimed), [encodeURIComponent(RUN)]);
  } finally {
    await claim.stop();
  }
  assert.equal(existsSync(claimed), false);
});

await test('a live run’s claim is passed over, and a gone run’s is swept', async () => {
  const live = first - SPAN + 100;
  const kept = plant(live, RUN);
  const gone = plant(live + 1, GONE_RUN);
  const claim = await claimPort({ start: 100, folder });
  claim.releaseNow();
  assert.notEqual(claim.port, live);
  assert.equal(existsSync(kept), true, 'a live run’s claim stays');
  assert.equal(existsSync(gone), false, 'a gone run’s claim is swept');
});

await test('two claims that start from the same port at once get two ports', async () => {
  const [one, two] = await Promise.all([
    claimPort({ start: 200, folder }),
    claimPort({ start: 200, folder }),
  ]);
  one.releaseNow();
  two.releaseNow();
  assert.notEqual(one.port, two.port);
});
