// The host's SOCKS5 server for the Linux image's browsers: their loopback is the host's, any other
// destination goes out as asked, and no client but theirs is answered.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';

import { onLoopback, routeOf, startSocks } from '../src/stack/socks.ts';

/** A site on the host's loopback that answers each request with the host it was asked for. */
const startSite = async (): Promise<{ port: number; close: () => void }> => {
  const server = createServer((incoming, outgoing) => {
    outgoing.end(`asked for ${incoming.headers.host ?? ''}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => {
      server.close();
    },
  };
};

/** The address part of a CONNECT for `host`: by name, or as IPv4. */
const addressOf = (host: string): Buffer =>
  /^\d+\.\d+\.\d+\.\d+$/u.test(host)
    ? Buffer.from([1, ...host.split('.').map(Number)])
    : Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host, 'latin1')]);

/** Everything `socket` says until it closes; a write the server closed on first is no failure. */
const heard = async (socket: Socket): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const failures: unknown[] = [];
  socket
    .on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    })
    .on('error', (error) => {
      failures.push(error);
    });
  // Not `once`, which fails on the error a reset socket emits before it closes.
  const { promise, resolve } = Promise.withResolvers<boolean>();
  socket.once('close', resolve);
  await promise;
  return Buffer.concat(chunks);
};

/** A client's whole exchange, its bytes sent one at a time, as a split packet would bring them:
 *  greeting, CONNECT to `host`:`port`, then an HTTP request; what it heard back. */
const exchange = async (socks: number, host: string, port: number): Promise<Buffer> => {
  const socket = connect(socks, '127.0.0.1');
  const answer = heard(socket);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const message = Buffer.concat([
    Buffer.from([5, 1, 0]),
    Buffer.from([5, 1, 0]),
    addressOf(host),
    portBytes,
  ]);
  for (const byte of message) {
    socket.write(Buffer.from([byte]));
  }
  socket.end(`GET / HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
  return answer;
};

await test('a CONNECT to localhost, a name under it or 127.0.0.1 reaches the host’s loopback, its bytes split or whole', async () => {
  const site = await startSite();
  const socks = await startSocks({ host: '127.0.0.1', peer: '127.0.0.1' });
  try {
    const hosts = ['localhost', 'app.localhost', '127.0.0.1'];
    const answers = await Promise.all(
      hosts.map(async (host) => exchange(socks.port, host, site.port)),
    );
    for (const [at, answer] of answers.entries()) {
      const host = hosts[at] ?? '';
      assert.deepEqual([...answer.subarray(0, 4)], [5, 0, 5, 0], host);
      assert.match(answer.toString('latin1'), new RegExp(`asked for ${host}$`, 'u'));
    }
  } finally {
    await socks.stop();
    site.close();
  }
});

await test('a CONNECT to a port nothing listens on is answered refused, and no client but the browsers’ is answered', async () => {
  const site = await startSite();
  site.close();
  const socks = await startSocks({ host: '127.0.0.1', peer: '127.0.0.1' });
  const stranger = await startSocks({ host: '127.0.0.1', peer: '192.0.2.7' });
  try {
    const refused = await exchange(socks.port, 'localhost', site.port);
    assert.deepEqual([...refused], [5, 0, 5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
    const unanswered = await exchange(stranger.port, 'localhost', site.port);
    assert.equal(unanswered.length, 0);
  } finally {
    await Promise.all([socks.stop(), stranger.stop()]);
  }
});

await test('a client offering only authentication, or asking anything but CONNECT, is refused', async () => {
  const socks = await startSocks({ host: '127.0.0.1', peer: '127.0.0.1' });
  try {
    const say = async (bytes: readonly number[]): Promise<number[]> => {
      const socket = connect(socks.port, '127.0.0.1');
      const answer = heard(socket);
      socket.write(Buffer.from(bytes));
      return [...(await answer)];
    };
    assert.deepEqual(await say([5, 1, 2]), [5, 255]);
    const bind = [5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80];
    assert.deepEqual(await say(bind), [5, 0, 5, 7, 0, 1, 0, 0, 0, 0, 0, 0]);
  } finally {
    await socks.stop();
  }
});

await test('the loopback’s names and addresses go to the host’s, by address where named; any other goes out as asked', () => {
  for (const host of [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '127.8.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
  ]) {
    assert.ok(onLoopback(host), host);
  }
  for (const host of ['checkout.stripe.com', 'localhost.example', '10.0.0.1', '128.0.0.1']) {
    assert.ok(!onLoopback(host), host);
  }
  assert.deepEqual(routeOf({ host: 'app.localhost', port: 8443 }), {
    host: '127.0.0.1',
    port: 8443,
  });
  assert.deepEqual(routeOf({ host: '::1', port: 80 }), { host: '::1', port: 80 });
  assert.deepEqual(routeOf({ host: 'checkout.stripe.com', port: 443 }), {
    host: 'checkout.stripe.com',
    port: 443,
  });
});
