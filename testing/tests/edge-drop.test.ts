// A live connection the edge drops as a lost link would: the browser's leg is ended and what the
// browser still sends is read, never reset, so a page sees a lost connection (1006) and no error.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import { test } from 'node:test';
import { connect, type TLSSocket } from 'node:tls';

import { firefox, type Page } from '@playwright/test';

import { CONTEXT_COOKIE } from '../src/network.ts';
import { CONTROL_PREFIX } from '../src/stack/contexts.ts';
import { type Edge, startEdge } from '../src/stack/edge.ts';
import { browserTrust } from '../src/stack/tls.ts';

const CONTEXT = 'drops';
/** Connections a context holds when one drop ends them all. */
const SOCKETS = 8;
/** Drops one after another in Firefox, each meeting frames on their way: the second on a context
 *  its first drop left. */
const ROUNDS = 2;
/** More than any socket buffer holds: a write of it completes only as the edge reads it. */
const AFTER_DROP = Buffer.alloc(16 * 1024 * 1024);
/** RFC 6455's key suffix, by which a switch proves it read the browser's key. */
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** A safety bound, not a wait: past it a regression fails the run instead of hanging it. It allows
 *  for Firefox's launch on a busy machine. */
const BOUND_MS = 120_000;

interface Site {
  readonly port: number;
  readonly close: () => void;
}

/** The site: a blank page, and a switch on `/socket` that reads all it's sent, telling the next of
 *  `waiters` when each connection's first bytes arrive. */
const startSite = async (waiters: (() => void)[]): Promise<Site> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>drops</title>');
  });
  server.on('upgrade', (incoming: IncomingMessage, socket: Socket) => {
    const key = String(incoming.headers['sec-websocket-key']);
    const accept = createHash('sha1').update(`${key}${ACCEPT_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.once('data', () => {
      const next = waiters.shift();
      if (next !== undefined) {
        next();
      }
    });
    socket.resume();
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

const edgeOn = async (site: Site): Promise<Edge> =>
  startEdge(
    { site: site.port, api: undefined, cacheControl: undefined, siteHost: undefined },
    new AbortController().signal,
  );

/** The edge's drop of the context's live connections, as a test steers it. */
const dropLive = async (edge: Edge): Promise<void> => {
  const url = new URL(`${CONTROL_PREFIX}${CONTEXT}/drop`, edge.origin);
  const answer = await new Promise<IncomingMessage>((resolve, reject) => {
    const sent = request(url, { ca: edge.trust.ca, method: 'POST', agent: false }, resolve);
    sent.once('error', reject);
    sent.end();
  });
  answer.resume();
  assert.equal(answer.statusCode, 204);
};

/** A client's connection through the edge in the context, switched, with what it meets watched
 *  from then on: the edge's end, its own close, and every error. */
interface Watched {
  readonly socket: TLSSocket;
  readonly ended: Promise<void>;
  readonly closed: Promise<void>;
  readonly errors: string[];
}

const switched = async (socket: TLSSocket): Promise<string> =>
  new Promise((resolve, reject) => {
    let head = '';
    const read = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        socket.off('data', read);
        resolve(head);
      }
    };
    socket.on('data', read);
    socket.once('error', reject);
  });

const upgraded = async (edge: Edge): Promise<Watched> => {
  const { hostname, port, host } = new URL(edge.origin);
  // Half open, so the client goes on sending once the edge has ended its side.
  const tcp = connectTcp({ host: hostname, port: Number(port), allowHalfOpen: true });
  const socket = connect({ socket: tcp, servername: hostname, ca: edge.trust.ca });
  await once(socket, 'secureConnect');
  socket.write(
    [
      'GET /socket HTTP/1.1',
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Cookie: ${CONTEXT_COOKIE}=wired.${CONTEXT}`,
      '',
      '',
    ].join('\r\n'),
  );
  assert.match(await switched(socket), /^HTTP\/1\.1 101 /u);
  const errors: string[] = [];
  socket.on('error', (error) => {
    errors.push(error.message);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
  });
  const ended = new Promise<void>((resolve) => {
    socket.once('end', () => {
      resolve();
    });
  });
  return { socket, ended: Promise.race([ended, closed]), closed, errors };
};

/** Once the edge has ended a dropped connection, the client sends AFTER_DROP and ends its own;
 *  the errors it met on the way. */
const sendAfterDrop = async ({ socket, ended, closed, errors }: Watched): Promise<string[]> => {
  await ended;
  await new Promise<void>((resolve) => {
    socket.write(AFTER_DROP, (error) => {
      if (error !== undefined && error !== null) {
        errors.push(`write: ${error.message}`);
      }
      resolve();
    });
  });
  socket.end();
  await closed;
  return errors;
};

await test(
  'a dropped live connection is ended, and what its client still sends is read, never reset',
  { timeout: BOUND_MS },
  async (context) => {
    const site = await startSite([]);
    context.after(site.close);
    const edge = await edgeOn(site);
    context.after(async () => edge.stop());
    const clients = await Promise.all(Array.from({ length: SOCKETS }, async () => upgraded(edge)));
    await dropLive(edge);
    const met = await Promise.all(clients.map(async (client) => sendAfterDrop(client)));
    assert.deepEqual(
      met,
      clients.map(() => []),
    );
  },
);

interface InFirefox {
  readonly page: Page;
  readonly errors: string[];
  readonly close: () => Promise<void>;
}

/** Firefox on `edge`'s page, in the context, its page's errors gathered. */
const firefoxOn = async (edge: Edge): Promise<InFirefox> => {
  const browser = await firefox.launch();
  const { ignoreHTTPSErrors } = browserTrust(edge.trust, 'firefox');
  const context = await browser.newContext({ ignoreHTTPSErrors });
  await context.addCookies([
    { name: CONTEXT_COOKIE, value: `wired.${CONTEXT}`, url: edge.origin, httpOnly: true },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.goto(`${edge.origin}/`);
  return { page, errors, close: async () => browser.close() };
};

/** Sockets on the page that send every millisecond from their opening, so frames are on their way
 *  whenever the drop comes; each answers the code it closes with. */
const sendUntilClosed = async (page: Page, url: string): Promise<number[]> =>
  page.evaluate(
    async ({ count, at }) =>
      Promise.all(
        Array.from(
          { length: count },
          async () =>
            new Promise<number>((resolve) => {
              const socket = new WebSocket(at);
              const sending = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send('x'.repeat(256));
                }
              }, 1);
              socket.addEventListener('close', (event) => {
                clearInterval(sending);
                resolve(event.code);
              });
            }),
        ),
      ),
    { count: SOCKETS, at: url },
  );

/** One drop in Firefox: the page's sockets, dropped once each one's first frame is upstream. */
const dropRound = async (page: Page, edge: Edge, waiters: (() => void)[]): Promise<number[]> => {
  const flowing = Array.from(
    { length: SOCKETS },
    async () =>
      new Promise<void>((resolve) => {
        waiters.push(resolve);
      }),
  );
  const closed = sendUntilClosed(page, `wss://${new URL(edge.origin).host}/socket`);
  await Promise.all(flowing);
  await dropLive(edge);
  return closed;
};

/** `rounds` of `drop`, one after another. */
const inTurn = async (rounds: number, drop: () => Promise<number[]>): Promise<number[][]> =>
  rounds === 0 ? [] : [await drop(), ...(await inTurn(rounds - 1, drop))];

await test(
  'in Firefox, each dropped socket closes as a lost one does, and the page has no error',
  { timeout: BOUND_MS },
  async (context) => {
    const waiters: (() => void)[] = [];
    const site = await startSite(waiters);
    context.after(site.close);
    const edge = await edgeOn(site);
    context.after(async () => edge.stop());
    const { page, errors, close } = await firefoxOn(edge);
    context.after(close);
    const codes = await inTurn(ROUNDS, async () => dropRound(page, edge, waiters));
    const lost = Array.from({ length: SOCKETS }, () => 1006);
    assert.deepEqual(
      codes,
      Array.from({ length: ROUNDS }, () => lost),
    );
    assert.deepEqual(errors, []);
  },
);
