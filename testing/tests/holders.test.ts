import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import { holdTurn } from '../src/stack/control.ts';
import { inWholeTurn, joinGate } from '../src/stack/gate-member.ts';
import { serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';
import { isObject } from '../src/unknown.ts';

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

/** Once a server in this process starts on a request whose path `path` matches, as Node
 *  announces it, by which time the server has taken it in. */
const servedOn = async (path: RegExp): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const heard = (message: unknown): void => {
    const request = isObject(message) ? message['request'] : undefined;
    if (request instanceof IncomingMessage && path.test(request.url ?? '')) {
      unsubscribe('http.server.request.start', heard);
      resolve(message);
    }
  };
  subscribe('http.server.request.start', heard);
  return promise;
};

await test('a whole turn holds every slot, named, while its work runs, and gives them back after', async () => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, 2), undefined);
  const gate = `http://127.0.0.1:${String(port)}`;
  const other = await joinGate(port);
  const ran: string[] = [];
  const later: { turn?: Promise<() => void> } = {};
  await inWholeTurn(
    async () => {
      ran.push('work');
      // The later turn reaches the gate as one slot for its run, and waits there.
      const atGate = servedOn(/^\/cpu\/[^/]+$/u);
      later.turn = holdTurn(other.turns).then((release) => {
        ran.push('a later turn');
        return release;
      });
      await atGate;
      const holders = await holdersAt(gate);
      assert.match(
        holders,
        /"what":"2 of the CPU gate's slots for run [^"]+","who":"the timed tests","since":\d+,"held":true/u,
      );
      assert.match(
        holders,
        /"what":"1 of the CPU gate's slots for run [^"]+","who":"pid \d+","since":\d+,"held":false/u,
      );
      ran.push('work done');
    },
    'the timed tests',
    port,
  );
  const { turn } = later;
  assert.ok(turn !== undefined, 'the later turn was asked for');
  (await turn)();
  other.leave();
  assert.deepEqual(ran, ['work', 'work done', 'a later turn']);
});
