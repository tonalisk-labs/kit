import assert from 'node:assert/strict';
import { test } from 'node:test';

import { holdTurn } from '../src/stack/control.ts';
import { joinGate } from '../src/stack/gate-member.ts';
import { serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';

/** What a server's GET /holders answers, as one JSON text. */
const holdersAt = async (url: URL | string): Promise<string> => {
  const answer = await fetch(new URL('/holders', url));
  const listed: unknown = await answer.json();
  return JSON.stringify(listed);
};

await test('the run and the gate list who holds their turns, by the name each holder gave', async () => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, 1), undefined);
  const run = await joinGate(port);
  const held = await holdTurn(run.turns);
  try {
    assert.match(
      await holdersAt(run.turns),
      /"what":"a CPU turn","who":"pid \d+","since":\d+,"held":true/u,
    );
    assert.match(
      await holdersAt(`http://127.0.0.1:${String(port)}`),
      /"what":"1 of the CPU gate's slots for run [^"]+","who":"pid \d+"/u,
    );
  } finally {
    held();
    run.leave();
  }
});
