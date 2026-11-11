// The host's end of the Linux image's shared browsers: a SOCKS5 server on the host's address on
// their network. Playwright's launch server, unlike its run server, carries no tunnel to the host's
// loopback (exposeNetwork), so each browser is launched with this server as its proxy. With a SOCKS
// proxy, Playwright's Chromium resolves no name itself, so every request a browser makes, its
// page's and its context's own, comes here: the loopback's go to the host's, and the rest out, as
// a contained browser's went out before.
import { once } from 'node:events';
import { connect, createServer, isIP, type Socket } from 'node:net';

import { codeOf } from '../unknown.ts';
import type { Service } from './process.ts';

/** Where a browser asked to connect. */
export interface Destination {
  readonly host: string;
  readonly port: number;
}

const VERSION = 5;
const NO_AUTHENTICATION = 0;
const NO_ACCEPTABLE_METHOD = 255;
const CONNECT = 1;
const TYPE = { ipv4: 1, name: 3, ipv6: 4 } as const;
const REPLY = {
  succeeded: 0,
  failed: 1,
  networkUnreachable: 3,
  hostUnreachable: 4,
  refused: 5,
  commandUnsupported: 7,
  addressUnsupported: 8,
} as const;

/** IPv6's loopback, as `ipv6Of` writes it. */
const IPV6_LOOPBACK = '0:0:0:0:0:0:0:1';

/** The names and addresses the host's loopback answers: Playwright's `<loopback>`, and all of
 *  127.0.0.0/8, which is the loopback too. */
export const onLoopback = (host: string): boolean =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  (isIP(host) === 4 && host.startsWith('127.')) ||
  host === '::1' ||
  host === IPV6_LOOPBACK;

/** Where a request goes from the host: a name on the loopback to 127.0.0.1, where every edge
 *  listens and macOS puts names under localhost; any other as it was asked. Behind a SOCKS proxy
 *  Playwright launches Chromium with `--host-resolver-rules=MAP * ~NOTFOUND`, so nothing else
 *  reaches out but through here, and the Stripe sandbox's journeys go to checkout.stripe.com. */
export const routeOf = ({ host, port }: Destination): Destination =>
  onLoopback(host) && isIP(host) === 0 ? { host: '127.0.0.1', port } : { host, port };

/** A reply with no bound address, which a browser never reads. */
const reply = (code: number): Buffer =>
  Buffer.from([VERSION, code, 0, TYPE.ipv4, 0, 0, 0, 0, 0, 0]);

/** Resolves once `socket` has more to read, or is gone. */
const stirred = async (socket: Socket): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const done = (): void => {
    socket.off('readable', done).off('close', done);
    resolve(true);
  };
  socket.on('readable', done).on('close', done);
  return promise;
};

/** The next `count` bytes from `socket`, once they have come; a failure if it ends first. */
const bytesOf = async (socket: Socket, count: number): Promise<Buffer> => {
  if (count === 0) {
    return Buffer.alloc(0);
  }
  const chunk: unknown = socket.read(count);
  if (Buffer.isBuffer(chunk) && chunk.length === count) {
    return chunk;
  }
  if (Buffer.isBuffer(chunk) || socket.readableEnded || socket.destroyed) {
    throw new Error('the client ended its SOCKS message part way');
  }
  await stirred(socket);
  return bytesOf(socket, count);
};

/** The client's greeting, answered: it must offer to go without authentication. */
const greet = async (client: Socket): Promise<void> => {
  const [version, count = 0] = await bytesOf(client, 2);
  if (version !== VERSION) {
    throw new Error(`a SOCKS${String(version)} greeting, not SOCKS5`);
  }
  const methods = await bytesOf(client, count);
  if (!methods.includes(NO_AUTHENTICATION)) {
    client.end(Buffer.from([VERSION, NO_ACCEPTABLE_METHOD]));
    throw new Error('the client offered no way without authentication');
  }
  client.write(Buffer.from([VERSION, NO_AUTHENTICATION]));
};

/** Sixteen bytes as an IPv6 address's eight groups, written out whole. */
const ipv6Of = (bytes: Buffer): string =>
  Array.from({ length: 8 }, (_unused, group) => bytes.readUInt16BE(group * 2).toString(16)).join(
    ':',
  );

/** The address a request names, by its type; undefined for a type SOCKS5 lacks. */
const hostOf = async (client: Socket, type: number | undefined): Promise<string | undefined> => {
  if (type === TYPE.ipv4) {
    const octets = await bytesOf(client, 4);
    return [...octets].join('.');
  }
  if (type === TYPE.ipv6) {
    return ipv6Of(await bytesOf(client, 16));
  }
  if (type === TYPE.name) {
    const [length = 0] = await bytesOf(client, 1);
    const name = await bytesOf(client, length);
    return name.toString('latin1');
  }
  return undefined;
};

/** The destination of the client's CONNECT; any other command, or address type, is refused. */
const destinationOf = async (client: Socket): Promise<Destination> => {
  const [, command, , type] = await bytesOf(client, 4);
  if (command !== CONNECT) {
    client.end(reply(REPLY.commandUnsupported));
    throw new Error(`SOCKS command ${String(command)}, which this server doesn't serve`);
  }
  const host = await hostOf(client, type);
  if (host === undefined) {
    client.end(reply(REPLY.addressUnsupported));
    throw new Error(`SOCKS address type ${String(type)}`);
  }
  const port = await bytesOf(client, 2);
  return { host, port: port.readUInt16BE(0) };
};

/** The reply for a connection that failed, by its error's code. */
const failureOf = (error: unknown): number => {
  const code = codeOf(error);
  if (code === 'ECONNREFUSED') {
    return REPLY.refused;
  }
  if (code === 'ENETUNREACH') {
    return REPLY.networkUnreachable;
  }
  return code === 'EHOSTUNREACH' || code === 'ENOTFOUND' ? REPLY.hostUnreachable : REPLY.failed;
};

/** Each side's end ends the other's writing, through the pipes, and a side closed or broken
 *  closes the other, so neither outlives its pair. */
const joined = (client: Socket, upstream: Socket): void => {
  for (const [one, other] of [
    [client, upstream],
    [upstream, client],
  ] as const) {
    const end = (): void => {
      other.destroy();
    };
    one.on('error', end).on('close', end);
  }
  client.pipe(upstream);
  upstream.pipe(client);
};

/** Serves one client: its greeting, its CONNECT, then its bytes both ways. */
const serve = async (client: Socket): Promise<void> => {
  await greet(client);
  const destination = routeOf(await destinationOf(client));
  const upstream = connect({ port: destination.port, host: destination.host, allowHalfOpen: true });
  // A browser that gives up first leaves no connection waiting on the operating system's timeout.
  client.once('close', () => {
    upstream.destroy();
  });
  try {
    await once(upstream, 'connect');
  } catch (error) {
    client.end(reply(failureOf(error)));
    return;
  }
  client.write(reply(REPLY.succeeded));
  joined(client, upstream);
};

export interface Socks extends Service {
  /** The port it listens on, at the address it was given. */
  readonly port: number;
}

/** A SOCKS5 server on `host`, serving only clients from `peer`, the browsers' own address: any
 *  other is closed unanswered, as it may reach the host's loopback through it. */
export const startSocks = async ({
  host,
  peer,
}: {
  readonly host: string;
  readonly peer: string;
}): Promise<Socks> => {
  const open = new Set<Socket>();
  // Half open, so a side that has said all it will still hears the other's answer.
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (client.remoteAddress !== peer) {
      client.destroy();
      return;
    }
    open.add(client);
    // A client that resets part way is closed, never an error the host's process throws.
    client
      .on('error', () => {
        client.destroy();
      })
      .once('close', () => {
        open.delete(client);
      });
    // A broken greeting or a client gone part way ends that client alone.
    serve(client).catch(() => {
      client.destroy();
    });
  });
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    stop: async () => {
      for (const client of open) {
        client.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
};
