// A CPU turn's release: one its own run let go ends whole, so the release finds no fault of the
// test's, as an interrupted run's does; one the gate drops while the run is in, or after the run lost
// the gate, is cut off, so its release says the work it covered ran unheld.
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { ClientRequest, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { holdTurn } from '../src/stack/control.ts';
import { joinGate } from '../src/stack/gate-member.ts';
import { GATE_MARK, GATE_VERSION, serveGate } from '../src/stack/gate-server.ts';
import { freePort } from '../src/stack/ports.ts';

const ASKED = 'http.client.request.start';

/** The next request this process makes to `pathname`, and its answer, as Node announces it. */
const nextCall = async (
  pathname: string,
): Promise<{ readonly call: ClientRequest; readonly answer: Promise<IncomingMessage> }> => {
  const { promise, resolve } = Promise.withResolvers<{
    call: ClientRequest;
    answer: Promise<IncomingMessage>;
  }>();
  const heard = (message: unknown): void => {
    const call: unknown =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'request') : undefined;
    if (call instanceof ClientRequest && call.path === pathname) {
      unsubscribe(ASKED, heard);
      const answer = new Promise<IncomingMessage>((answered) => {
        call.once('response', answered);
      });
      resolve({ call, answer });
    }
  };
  subscribe(ASKED, heard);
  return promise;
};

await test('a turn its run lets go ends whole, so its release finds no fault of the test’s', async () => {
  const port = await freePort();
  assert.notEqual(await serveGate(port, 1), undefined);
  const run = await joinGate(port);
  const asked = nextCall('/cpu');
  const release = await holdTurn(run.turns);
  const { call, answer } = await asked;
  // The run's last leave closes every turn at the gate, as an interrupted run's does.
  run.leave();
  await once(call, 'close');
  const answered = await answer;
  assert.equal(answered.complete, true);
  assert.doesNotThrow(release);
});

/** A gate that grants a run's first join and its turns; `cut` ends the turns it granted, as a
 *  restarting gate does, and `dropJoin` the join, after which it answers as no gate. */
interface FakeGate {
  readonly port: number;
  readonly cut: () => void;
  readonly dropJoin: () => void;
  readonly close: () => void;
}

const fakeGate = async (): Promise<FakeGate> => {
  const port = await freePort();
  const granted = new Set<ServerResponse>();
  const state: { join: ServerResponse | undefined; dropped: boolean } = {
    join: undefined,
    dropped: false,
  };
  const server = createServer({ requestTimeout: 0 }, (incoming, outgoing) => {
    incoming.resume();
    const joining = (incoming.url ?? '').startsWith('/join/');
    if (state.dropped) {
      outgoing.writeHead(404).end(joining ? 'no gate here' : 'no such run');
    } else if (joining) {
      state.join = outgoing;
      outgoing.writeHead(200, { [GATE_MARK]: GATE_VERSION }).flushHeaders();
    } else {
      granted.add(outgoing);
      outgoing.writeHead(200).flushHeaders();
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    port,
    cut: () => {
      for (const turn of granted) {
        turn.destroy();
      }
      granted.clear();
    },
    dropJoin: () => {
      state.dropped = true;
      if (state.join !== undefined) {
        state.join.destroy();
      }
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

await test('a turn the gate drops while its run is in is cut off, so its release says it ran unheld', async () => {
  const gate = await fakeGate();
  const run = await joinGate(gate.port);
  try {
    const asked = nextCall('/cpu');
    const release = await holdTurn(run.turns);
    const { call, answer } = await asked;
    gate.cut();
    await once(call, 'close');
    const answered = await answer;
    assert.equal(answered.complete, false);
    assert.throws(
      release,
      /a CPU turn ended before its release, so the work it covered ran without it/u,
    );
  } finally {
    run.leave();
    gate.close();
  }
});

await test('a turn the gate drops after its run lost the gate is cut off too: the run never let go', async () => {
  const gate = await fakeGate();
  const run = await joinGate(gate.port);
  try {
    const asked = nextCall('/cpu');
    const release = await holdTurn(run.turns);
    const { call, answer } = await asked;
    // The join drops and the rejoin finds no gate: the run has lost it, and refuses a turn so.
    gate.dropJoin();
    await assert.rejects(
      holdTurn(run.turns),
      /refused a turn \(503\): the run has left it, or lost it/u,
    );
    gate.cut();
    await once(call, 'close');
    const answered = await answer;
    assert.equal(answered.complete, false);
    assert.throws(
      release,
      /a CPU turn ended before its release, so the work it covered ran without it/u,
    );
  } finally {
    run.leave();
    gate.close();
  }
});
