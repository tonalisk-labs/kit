// The browser leg the edge ends is read until the browser ends its own, and let go after nginx's
// lingering bound when that end never comes, so a peer that stays open holds nothing.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { test } from 'node:test';

import { linger } from '../src/stack/live.ts';

/** The edge's bound, nginx's lingering_time. */
const BOUND_MS = 30_000;

interface Connection {
  /** The edge's side, which lingers. */
  readonly near: Socket;
  /** The browser's side, half open: it reads the edge's end and never ends its own. */
  readonly far: Socket;
  readonly close: () => void;
}

const connection = async (): Promise<Connection> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const accepted = new Promise<Socket>((resolve) => {
    server.once('connection', resolve);
  });
  const far = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  const near = await accepted;
  return {
    near,
    far,
    close: () => {
      far.destroy();
      server.close();
    },
  };
};

await test('a browser leg that never ends its side is let go once the bound has passed', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { near, far, close } = await connection();
  context.after(close);
  const ended = once(far, 'end');
  linger(near);
  linger(near);
  await ended;
  context.mock.timers.tick(BOUND_MS - 1);
  assert.equal(near.destroyed, false);
  context.mock.timers.tick(1);
  assert.equal(near.destroyed, true);
});
