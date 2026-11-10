// The edge's hops, a connection per request so an upstream's idle close is never a 502; its answers
// when an upstream fails, before or after answering; and the refusals a test queues for it.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type ClientHttp2Session, connect, constants } from 'node:http2';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { type Edge, startEdge } from '../src/stack/edge.ts';
import { fetchOver } from './edge-fetch.ts';

const SCRIPT = Buffer.alloc(8000, 'x');
const REQUESTS = 300;
const CUT_BYTES = 100_000;

/** The site's answers by path; any other path answers a script. */
const ANSWERS: Readonly<
  Record<string, (request: IncomingMessage, response: ServerResponse) => void>
> = {
  // Resets the connection before any answer.
  '/reset': (request) => {
    request.socket.destroy();
  },
  // Begins a long answer, then resets the connection once its first bytes are sent.
  '/cut': (request, response) => {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(CUT_BYTES) });
    response.write(Buffer.alloc(1000), () => {
      request.socket.destroy();
    });
  },
  // A script with a strong tag, which says the If-None-Match the edge passed on.
  '/tagged': (request, response) => {
    response.writeHead(200, {
      'content-type': 'text/javascript',
      etag: '"v1"',
      'x-if-none-match': request.headers['if-none-match'] ?? '',
    });
    response.end(SCRIPT);
  },
};

/** The site's upgrades: switched and echoed on `/socket`, refused on `/refused`, reset elsewhere. */
const upgradeOnSite = (request: IncomingMessage, socket: Socket): void => {
  const { pathname } = new URL(request.url ?? '/', 'http://site');
  if (pathname === '/socket') {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.pipe(socket);
  } else if (pathname === '/refused') {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  } else {
    socket.destroy();
  }
};

/** A site answering as ANSWERS says, counting its connections; each request closes those idle
 *  since answering, as a server may at any time, never one whose first request is on its way. */
const startSite = async (): Promise<{
  server: Server;
  port: number;
  connections: () => number;
}> => {
  const seen = { connections: 0 };
  const keptAlive = new Set<Socket>();
  const server = createServer((request, response) => {
    keptAlive.delete(request.socket);
    for (const socket of keptAlive) {
      socket.destroy();
    }
    keptAlive.clear();
    response.on('finish', () => {
      if (!request.socket.destroyed) {
        keptAlive.add(request.socket);
      }
    });
    const answer = ANSWERS[new URL(request.url ?? '/', 'http://site').pathname];
    if (answer === undefined) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(SCRIPT);
    } else {
      answer(request, response);
    }
  });
  server.on('upgrade', upgradeOnSite);
  server.on('connection', (socket: Socket) => {
    seen.connections += 1;
    socket.on('close', () => {
      keptAlive.delete(socket);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, port, connections: () => seen.connections };
};

/** A loopback port nothing listens on: taken, then given back. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  return typeof address === 'object' && address !== null ? address.port : 0;
};

/** The edge's answer to a request over HTTP/1.1, the protocol upgrades and fallbacks take. */
const fetchOver1 = async (edge: Edge, path: string): Promise<number> => {
  const sent = httpsRequest(new URL(path, edge.origin), { ca: edge.trust.ca, agent: false });
  sent.end();
  const answer = await new Promise<IncomingMessage>((resolve) => {
    sent.once('response', resolve);
  });
  answer.resume();
  await once(answer, 'end');
  return answer.statusCode ?? 0;
};

/** What the edge answers an upgrade with: the status line, and for a switch the echo of `said`. */
const upgradeOver = async (edge: Edge, path: string, said: string): Promise<string> => {
  const sent = httpsRequest(new URL(path, edge.origin), {
    ca: edge.trust.ca,
    agent: false,
    headers: { connection: 'Upgrade', upgrade: 'websocket', cookie: 'sites-context=lossy' },
  });
  sent.end();
  const upgraded = new Promise<string>((resolve) => {
    sent.once('upgrade', (_answer: IncomingMessage, socket: Socket) => {
      socket.once('data', (echo: Buffer) => {
        socket.destroy();
        resolve(`101 ${echo.toString()}`);
      });
      socket.write(said);
    });
  });
  const answered = new Promise<string>((resolve) => {
    sent.once('response', (answer: IncomingMessage) => {
      answer.resume();
      resolve(String(answer.statusCode));
    });
  });
  return Promise.race([upgraded, answered]);
};

/** The browser context the fault tests steer, and what its origin answers. */
const FAULTS = 'faults';
const ORIGIN = { status: 200, retryAfter: undefined };

/** The status and `Retry-After` the edge answers the fault tests' context with. */
const faultedOver = async (
  session: ClientHttp2Session,
  path: string,
  method: string,
): Promise<{ status: number; retryAfter: string | undefined }> => {
  const cookie = `sites-context=${FAULTS}`;
  const { status, headers } = await fetchOver(session, {
    ':path': path,
    ':method': method,
    cookie,
  });
  const retryAfter = headers['retry-after'];
  return { status, retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined };
};

const site = await startSite();
const edge = await startEdge(
  {
    site: site.port,
    api: { prefix: '/api', port: await closedPort() },
    cacheControl: (_path, status) => (status === 200 ? 'public, max-age=60' : 'no-store'),
    siteHost: undefined,
    headers: (path) =>
      path.startsWith('/api/')
        ? { 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }
        : { 'x-content-type-options': 'nosniff' },
  },
  new AbortController().signal,
);
const session = connect(edge.origin, { ca: edge.trust.ca });
const said: string[] = [];
/** Steers the fault tests' context; answers the control's status. */
const steer = async (action: string): Promise<number> => {
  const { status } = await faultedOver(
    session,
    `/.sites-testing/contexts/${FAULTS}/${action}`,
    'POST',
  );
  return status;
};
const faulted = async (
  path: string,
  method: string,
): Promise<{ status: number; retryAfter: string | undefined }> =>
  faultedOver(session, path, method);

/** A request the edge's fault answers: its status, type and body, and whether its stream reset. */
const cutOver = async (
  path: string,
  method: string,
): Promise<{ status: number; type: unknown; body: string; reset: boolean }> => {
  const stream = session.request(
    { ':path': path, ':method': method, cookie: `sites-context=${FAULTS}` },
    { endStream: true },
  );
  const head = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
    stream.once('response', resolve);
  });
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });
  // A reset stream also errors, which would reject a plain wait for its close: its code is read.
  const errors: string[] = [];
  stream.on('error', (error: Error) => {
    errors.push(error.message);
  });
  await new Promise((closed) => {
    stream.once('close', closed);
  });
  const answered = await head;
  return {
    status: Number(answered[':status']),
    type: answered['content-type'],
    body: Buffer.concat(chunks).toString(),
    reset: stream.rstCode !== constants.NGHTTP2_NO_ERROR,
  };
};
const report = console.error;
console.error = (line: unknown): void => {
  said.push(String(line));
};

try {
  await test('many parallel static requests over 3G all answer, each on its own upstream connection', async () => {
    const before = site.connections();
    const steered = await fetchOver(session, {
      ':path': '/.sites-testing/contexts/3g/network/3g',
      ':method': 'POST',
      cookie: 'sites-context=3g',
    });
    assert.equal(steered.status, 204);
    const answers = await Promise.all(
      Array.from({ length: REQUESTS }, async (_request, at) =>
        fetchOver(session, { ':path': `/_astro/${String(at)}.js`, cookie: 'sites-context=3g' }),
      ),
    );
    // A 502 says why in the edge's own words: what its upstream failed with.
    const failures = said.filter((line) => line.startsWith('edge proxy: upstream ')).join('\n');
    assert.deepEqual(new Set(answers.map(({ status }) => status)), new Set([200]), failures);
    assert.equal(site.connections() - before, REQUESTS);
  });

  await test('an upstream that resets before answering is a 502, and the edge says so', async () => {
    const [site502, api502] = await Promise.all([
      fetchOver(session, { ':path': '/reset' }),
      fetchOver(session, { ':path': '/api/anything' }),
    ]);
    assert.deepEqual([site502.status, api502.status], [502, 502]);
    assert.ok(said.some((line) => line.startsWith('edge proxy: upstream ')));
  });

  await test('an upstream that resets midway cuts the answer the browser was receiving', async () => {
    await assert.rejects(fetchOver(session, { ':path': '/cut' }), {
      code: 'ERR_HTTP2_STREAM_ERROR',
    });
  });

  await test("the site's answers carry the edge's Cache-Control, encoded as the browser asks", async () => {
    const answer = await fetchOver(session, {
      ':path': '/tagged',
      'accept-encoding': 'gzip',
      'if-none-match': '"v1-gzip"',
    });
    assert.equal(answer.headers['cache-control'], 'public, max-age=60');
    assert.equal(answer.headers['etag'], '"v1-gzip"');
    assert.equal(answer.headers['x-if-none-match'], '"v1"');
    assert.deepEqual(gunzipSync(answer.body), SCRIPT);
  });

  await test("an answer carries the edge's headers for the path it was asked by", async () => {
    const page = await fetchOver(session, { ':path': '/tagged?query=1' });
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-robots-tag'], undefined);
  });

  await test('an HTTP/1.1 client is answered as an HTTP/2 one', async () => {
    assert.equal(await fetchOver1(edge, '/'), 200);
    assert.equal(await fetchOver1(edge, '/reset'), 502);
  });

  await test('an upgrade is switched, refused as the upstream refuses it, or a 502', async () => {
    await fetchOver(session, {
      ':path': '/.sites-testing/contexts/lossy/network/lossy',
      ':method': 'POST',
      cookie: 'sites-context=lossy',
    });
    assert.equal(await upgradeOver(edge, '/socket', 'ping'), '101 ping');
    assert.equal(await upgradeOver(edge, '/refused', 'ping'), '403');
    assert.equal(await upgradeOver(edge, '/gone', 'ping'), '502');
  });

  await test('queued faults answer the next matching requests in order, once each, then the origin', async () => {
    assert.equal(await steer('network/3g'), 204);
    assert.equal(await steer('fault/POST/402/0/notes/*/updates'), 204);
    assert.equal(await steer('fault/POST/503/1/notes/*/updates'), 204);
    assert.equal(await steer('fault/POST/200/0/notes'), 400, 'only a refusal');
    assert.deepEqual(await faulted('/notes/a/updates', 'GET'), ORIGIN, 'another method');
    assert.deepEqual(await faulted('/notes/a', 'POST'), ORIGIN, 'another path');
    assert.deepEqual(await faulted('/notes/a/updates', 'POST'), {
      status: 402,
      retryAfter: undefined,
    });
    assert.deepEqual(await faulted('/notes/b/updates?at=1', 'POST'), {
      status: 503,
      retryAfter: '1',
    });
    assert.deepEqual(await faulted('/notes/a/updates', 'POST'), ORIGIN, 'each once');
  });

  await test('a body reset partway is a head and its first bytes, then a reset stream', async () => {
    assert.equal(await steer('fault/GET/reset/0/api/notes'), 204);
    const cut = await cutOver('/api/notes', 'GET');
    assert.deepEqual([cut.status, cut.type, cut.reset], [200, 'application/json', true]);
    assert.ok(cut.body.length > 0 && !cut.body.endsWith('}'), cut.body);
  });

  await test('a portal answers a web page with 200 where the origin’s answer belongs', async () => {
    assert.equal(await steer('fault/POST/page/0/api/notes/*/updates'), 204);
    const page = await cutOver('/api/notes/a/updates', 'POST');
    assert.deepEqual(
      [page.status, page.type, page.reset],
      [200, 'text/html; charset=utf-8', false],
    );
    assert.match(page.body, /^<!doctype html>/u);
  });

  await test('a hung request has no answer while later ones do, until its client gives up', async () => {
    assert.equal(await steer('fault/GET/hang/0/api/feed'), 204);
    const hung = session.request(
      { ':path': '/api/feed', cookie: `sites-context=${FAULTS}` },
      { endStream: true },
    );
    const errors: string[] = [];
    hung.on('error', (error: Error) => {
      errors.push(error.message);
    });
    const heard = { answer: false };
    hung.once('response', () => {
      heard.answer = true;
    });
    // A request sent after it is answered: the edge has had the hung one, and held it.
    assert.deepEqual(await faulted('/notes/a', 'GET'), ORIGIN);
    assert.equal(heard.answer, false);
    hung.close(constants.NGHTTP2_CANCEL);
    await once(hung, 'close');
    assert.equal(heard.answer, false);
  });

  await test('a segment with a star matches a chunk whatever its hash, and no other name', async () => {
    assert.equal(await steer('fault/GET/404/0/_astro/workspace.*.js'), 204);
    assert.equal(await steer('fault/GET/404/0/_astro/workspace.*.js'), 204);
    assert.deepEqual(await faulted('/_astro/workspaces.BSPS7ISR.js', 'GET'), ORIGIN);
    assert.deepEqual(await faulted('/_astro/workspace-BSPS7ISR.js', 'GET'), ORIGIN);
    assert.deepEqual(await faulted('/_astro/workspace.BSPS7ISR.js', 'GET'), {
      status: 404,
      retryAfter: undefined,
    });
    assert.deepEqual(await faulted('/_astro/workspace.k2_Qw-8Z.js', 'GET'), {
      status: 404,
      retryAfter: undefined,
    });
  });

  await test('a cleared queue leaves every request to the origin', async () => {
    assert.equal(await steer('fault/POST/503/1/notes/*/updates'), 204);
    assert.equal(await steer('faults/clear'), 204);
    assert.deepEqual(await faulted('/notes/a/updates', 'POST'), ORIGIN);
  });
} finally {
  console.error = report;
  // The client leaves first, its session closed, so the edge's stop resets no live connection.
  await new Promise<void>((resolve) => {
    session.close(resolve);
  });
  await edge.stop();
  await new Promise<void>((resolve) => {
    site.server.close(() => {
      resolve();
    });
  });
}
