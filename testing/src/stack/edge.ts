import { once } from 'node:events';
import { Agent, type IncomingHttpHeaders, type IncomingMessage, request } from 'node:http';
import { createSecureServer, type Http2SecureServer, Http2ServerRequest } from 'node:http2';
import type { Socket } from 'node:net';
import { pipeline, type Readable, type Transform } from 'node:stream';

import { CONTEXT_COOKIE } from '../network.ts';
import { answerFault, type Outgoing, writeHead } from './answers.ts';
import {
  CONTROL_PREFIX,
  contextOf,
  type EdgeContext,
  faultFor,
  heldMs,
  steer,
} from './contexts.ts';
import { encoded, forwardedNoneMatch } from './encode.ts';
import { hold, linger, pipeDown } from './live.ts';
import { CONNECTS_AT_ONCE } from './ports.ts';
import { type Service, withoutIpv6 } from './process.ts';
import { AHEAD_BYTES, headDelayMs, type Link, shaper } from './shaping.ts';
import { type EdgeSigning, makeEdgeCertificate, type Trust } from './tls.ts';

export interface Upstreams {
  /** The built site, which serves every path the API does not. */
  readonly site: number;
  /** The backend, reached under `prefix`, which is stripped as the production edge does. */
  readonly api: { readonly prefix: string; readonly port: number } | undefined;
  /** The production edge's `Cache-Control` for the site's answers; none keeps the site's own. */
  readonly cacheControl: ((path: string, status: number) => string) | undefined;
  /** The production edge's headers for an answer, the API's too, by the path the browser asked
   *  for; none adds none. */
  readonly headers?: (path: string) => Readonly<Record<string, string>>;
  /** The Host the site is asked by, as a CDN asks its origin; none passes the browser's on. */
  readonly siteHost: string | undefined;
}

export interface Edge extends Service {
  /** The one public origin, over TLS: pages, API and sockets, as in production. */
  readonly origin: string;
  readonly trust: Trust;
}

/** A request as either protocol hands it over: HTTP/2, or HTTP/1.1 for upgrades and fallbacks. */
type Incoming = IncomingMessage | Http2ServerRequest;

/** Headers of one hop only, which a proxy does not pass on (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Caddy's `handle_path <prefix>/*`: the prefix is stripped from what it matches. */
const route = (upstreams: Upstreams, url: string): { port: number; path: string } => {
  const { api } = upstreams;
  return api !== undefined && url.startsWith(`${api.prefix}/`)
    ? { port: api.port, path: url.slice(api.prefix.length) }
    : { port: upstreams.site, path: url };
};

/** The request's cookies without the harness's own, which only the edge reads. */
const cookiesWithout = (header: string): string =>
  header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => !pair.startsWith(`${CONTEXT_COOKIE}=`))
    .join('; ');

const clientAddress = (incoming: Incoming, context: EdgeContext | undefined): string =>
  context === undefined ? (incoming.socket.remoteAddress ?? '127.0.0.1') : context.ip;

/** The host the browser asked for: HTTP/2 names it in `:authority`, HTTP/1.1 in `Host`. */
const authorityOf = (incoming: Incoming): string | undefined =>
  incoming instanceof Http2ServerRequest ? incoming.authority : incoming.headers.host;

const forwardedHeaders = (
  incoming: Incoming,
  context: EdgeContext | undefined,
  host: string | undefined,
): IncomingHttpHeaders => {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    // HTTP/2's pseudo-headers (`:path`, `:authority`) have no place on the HTTP/1.1 hop.
    if (!HOP_BY_HOP.has(name) && !name.startsWith(':')) {
      headers[name] = value;
    }
  }
  const authority = authorityOf(incoming);
  headers.host = host ?? authority;
  headers.cookie = cookiesWithout(incoming.headers.cookie ?? '');
  headers['x-forwarded-for'] = clientAddress(incoming, context);
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = authority;
  // The edge encodes, as production's does over upstreams that send their bytes as they are.
  headers['accept-encoding'] = 'identity';
  const noneMatch = forwardedNoneMatch(incoming);
  if (noneMatch !== undefined) {
    headers['if-none-match'] = noneMatch;
  }
  return headers;
};

/** Browsers abandon requests whenever they navigate; that is traffic, not a fault. */
const abandoned = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(error.code));

const report = (error: Error | null | undefined): void => {
  if (error !== null && error !== undefined && !abandoned(error)) {
    console.error(`edge proxy: ${error.message}`);
  }
};

interface Router {
  readonly upstreams: Upstreams;
  readonly contexts: Map<string, EdgeContext>;
  /** The connections (HTTP/2 sessions, HTTP/1.1 sockets) that have paid for their handshakes. */
  readonly opened: WeakSet<object>;
}

/** The harness's own requests steer a context; they never reach the site or the backend. */
const control = (router: Router, incoming: Incoming, outgoing: Outgoing): boolean => {
  const url = incoming.url ?? '/';
  if (incoming.method !== 'POST' || !url.startsWith(CONTROL_PREFIX)) {
    return false;
  }
  incoming.resume();
  writeHead(outgoing, steer(router.contexts, url));
  outgoing.end();
  return true;
};

const upOf = (context: EdgeContext | undefined): Link | undefined =>
  context === undefined ? undefined : context.up;

const downOf = (context: EdgeContext | undefined): Link | undefined =>
  context === undefined ? undefined : context.down;

/** A message head's size as HTTP/1.1 sends it: what it takes of the link. */
const headBytes = (rawHeaders: readonly string[]): number =>
  rawHeaders.reduce((sum, field) => sum + field.length + 2, 0);

/** Runs `then` once `ms` have passed on the emulated link; the timer is the network itself. */
const after = (ms: number, then: () => void): void => {
  if (ms > 0) {
    setTimeout(then, ms);
  } else {
    then();
  }
};

/** TCP's and TLS 1.3's round trips, which the first request on a connection waits for. */
const HANDSHAKE_RTTS = 2;

const owedRtts = (router: Router, incoming: Incoming): number => {
  const connection =
    incoming instanceof Http2ServerRequest ? incoming.stream.session : incoming.socket;
  if (connection === undefined || router.opened.has(connection)) {
    return 0;
  }
  router.opened.add(connection);
  return HANDSHAKE_RTTS;
};

/** `cache` is set for the site's answers alone; `added` for every answer. */
interface Onward {
  readonly link: Link | undefined;
  readonly cache: ((status: number) => string) | undefined;
  readonly added: Readonly<Record<string, string>>;
}

/** The production edge's headers for an answer to `url`, as the browser asked for it. */
const addedFor = ({ headers }: Upstreams, url: string): Onward['added'] => {
  const [pathname = url] = url.split('?');
  return headers === undefined ? {} : headers(pathname);
};

const cachedFor = (upstreams: Upstreams, port: number, path: string): Onward['cache'] => {
  const { cacheControl, site } = upstreams;
  const [pathname = path] = path.split('?');
  return cacheControl === undefined || port !== site
    ? undefined
    : (status) => cacheControl(pathname, status);
};

interface Exchange {
  readonly incoming: Incoming;
  /** The request's body as the context's link delivers it. */
  readonly body: Readable;
  readonly outgoing: Outgoing;
  readonly context: EdgeContext | undefined;
}

const answerWith =
  (incoming: Incoming, outgoing: Outgoing, { link, cache, added }: Onward) =>
  (answer: IncomingMessage): void => {
    const wait = headDelayMs(link, headBytes(answer.rawHeaders), 0);
    const { headers, encoder } = encoded(incoming, answer, HOP_BY_HOP);
    if (cache !== undefined) {
      headers['cache-control'] = cache(answer.statusCode ?? 502);
    }
    Object.assign(headers, added);
    const body = shaper(link, AHEAD_BYTES);
    if (encoder === undefined) {
      pipeline(answer, body, report);
    } else {
      pipeline(answer, encoder, body, report);
    }
    after(wait, () => {
      // The browser may have gone (a closed tab, a navigation) before the answer came.
      if (outgoing.destroyed || outgoing.headersSent) {
        body.destroy();
        return;
      }
      writeHead(outgoing, answer.statusCode ?? 502, headers);
      pipeline(body, outgoing, report);
    });
  };

/** A failed upstream is logged whatever its error, as only browsers abandon: a 502 while nothing
 *  was sent, else a reset with the error, as production's, since a plain end reads as whole. */
const failWith = (outgoing: Outgoing, error: Error): void => {
  console.error(`edge proxy: upstream ${error.message}`);
  if (outgoing.destroyed) {
    return;
  }
  if (outgoing.headersSent) {
    outgoing.destroy(error);
  } else {
    writeHead(outgoing, 502);
    outgoing.end();
  }
};

/** Upstream connections, each closed after its one request: kept alive, it races the idle close. */
const POOL = new Agent({ keepAlive: false, maxSockets: CONNECTS_AT_ONCE });

const forward = (router: Router, exchange: Exchange): void => {
  const { incoming, body, outgoing, context } = exchange;
  const { upstreams } = router;
  const { port, path } = route(upstreams, incoming.url ?? '/');
  const host = port === upstreams.site ? upstreams.siteHost : undefined;
  const headers = Object.assign(forwardedHeaders(incoming, context, host), { connection: 'close' });
  const options = { host: '127.0.0.1', port, path, method: incoming.method, headers, agent: POOL };
  const onward = {
    link: downOf(context),
    cache: cachedFor(upstreams, port, path),
    added: addedFor(upstreams, incoming.url ?? '/'),
  };
  const upstream = request(options, answerWith(incoming, outgoing, onward));
  upstream.on('error', (error) => {
    failWith(outgoing, error);
  });
  pipeline(body, upstream, report);
};

/** Carries each request (HTTP/2 stream or HTTP/1.1 exchange) across its context's link: the head
 *  waits its turn and flight, and the body and the answer go by the slice. */
const proxy =
  (router: Router) =>
  (incoming: Incoming, outgoing: Outgoing): void => {
    if (control(router, incoming, outgoing)) {
      return;
    }
    const context = contextOf(router.contexts, incoming.headers.cookie ?? '');
    const link = upOf(context);
    const wait = headDelayMs(link, headBytes(incoming.rawHeaders), owedRtts(router, incoming));
    const body = shaper(link);
    pipeline(incoming, body, report);
    after(wait + heldMs(context, incoming.url ?? '/'), () => {
      if (outgoing.destroyed) {
        return;
      }
      const owed = faultFor(context, incoming.method ?? 'GET', incoming.url ?? '/');
      if (owed === undefined) {
        forward(router, { incoming, body, outgoing, context });
      } else {
        body.resume();
        answerFault(owed, outgoing);
      }
    });
  };

/** A response head for a socket the router has handed over; `close` drops the hop's own
 *  headers, as the body is passed decoded, and ends the connection with the body. */
const headOf = (answer: IncomingMessage, close: boolean): string => {
  const lines = [`HTTP/1.1 ${String(answer.statusCode)} ${answer.statusMessage ?? ''}`];
  for (let index = 0; index < answer.rawHeaders.length; index += 2) {
    const [name = '', value = ''] = answer.rawHeaders.slice(index, index + 2);
    if (!close || !HOP_BY_HOP.has(name.toLowerCase())) {
      lines.push(`${name}: ${value}`);
    }
  }
  if (close) {
    lines.push('Connection: close');
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

interface Upgrade {
  readonly incoming: IncomingMessage;
  readonly client: Socket;
  /** The client's two directions across the context's link. */
  readonly up: Transform;
  readonly down: Transform;
  readonly context: EdgeContext | undefined;
}

/** An upgrade's raw headers as the upstream gets them: the harness cookie dropped, and the
 *  client's address added. */
const upgradeHeaders = (incoming: IncomingMessage, context: EdgeContext | undefined): string[] => {
  const headers: string[] = [];
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const [name = '', value = ''] = incoming.rawHeaders.slice(index, index + 2);
    headers.push(name, name.toLowerCase() === 'cookie' ? cookiesWithout(value) : value);
  }
  headers.push('X-Forwarded-For', clientAddress(incoming, context));
  return headers;
};

/** As `failWith`: a 502 while nothing was sent, else the browser's leg ends, lingering. */
const failUpgrade = (client: Socket, down: Transform, answered: boolean): void => {
  if (client.destroyed) {
    return;
  }
  if (answered) {
    linger(client);
  } else {
    down.end(BAD_GATEWAY);
  }
};

/** Sends the upgrade on once its head has crossed the link. Only a switch joins the sockets. */
const send = (router: Router, { incoming, client, up, down, context }: Upgrade): void => {
  const { port, path } = route(router.upstreams, incoming.url ?? '/');
  const headers = upgradeHeaders(incoming, context);
  const options = { host: '127.0.0.1', port, path, method: incoming.method, headers };
  const upstream = request(Object.assign(options, { agent: false }));
  const answered = { now: false };
  upstream.on('upgrade', (answer: IncomingMessage, socket: Socket, rest: Buffer) => {
    answered.now = true;
    if (client.destroyed) {
      socket.destroy();
      return;
    }
    down.write(headOf(answer, false));
    down.write(rest);
    pipeline(up, socket, report);
    pipeline(socket, down, report);
    hold(client, socket, context);
  });
  upstream.on('response', (answer: IncomingMessage) => {
    answered.now = true;
    if (client.destroyed) {
      answer.destroy();
      return;
    }
    down.write(headOf(answer, true));
    pipeline(answer, down, report);
  });
  upstream.on('error', (error) => {
    console.error(`edge proxy: upstream ${error.message}`);
    failUpgrade(client, down, answered.now);
  });
  upstream.end();
};

/** Passes an upgrade on with only its path and harness cookie changed; a refusal closes the
 *  connection, so nothing sent on it next goes unrouted. Piping adds few listeners to it. */
const upgrade =
  (router: Router) =>
  (incoming: IncomingMessage, client: Socket, head: Buffer): void => {
    const context = contextOf(router.contexts, incoming.headers.cookie ?? '');
    const [up, down] = [shaper(upOf(context)), shaper(downOf(context))];
    client.on('error', report);
    up.write(head);
    client.pipe(up);
    pipeDown(down, client);
    const bytes = headBytes(incoming.rawHeaders);
    after(headDelayMs(upOf(context), bytes, owedRtts(router, incoming)), () => {
      send(router, { incoming, client, up, down, context });
    });
  };

const listening = async (
  server: Http2SecureServer,
  port: number,
  host: string,
): Promise<number> => {
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : Number.NaN;
};

const closed = async (server: Http2SecureServer): Promise<void> => {
  server.close();
  await once(server, 'close');
};

/** How long the router and the fakes keep an idle connection: longer than any client keeps its
 *  own (Firefox 115 s, reqwest's pool 90 s), so the client is always the one to close it. */
export const IDLE_CONNECTION_MS = 10 * 60_000;

/** HTTP/2 receive windows, per stream and per connection: Caddy's (Go's) 1 MiB, not Node's
 *  64 KiB, so one slow upload does not hold the others' bodies back. */
const WINDOW_BYTES = 1024 * 1024;

/** One of the edge's servers, which outlasts any browser's idle connection as production's does:
 *  closing one first races a request the browser is sending on it, which then goes unanswered. */
const edgeServer = (
  router: Router,
  { key, cert }: { readonly key: string; readonly cert: string },
  sockets: Set<Socket>,
): Http2SecureServer => {
  const server = createSecureServer({
    key,
    cert,
    allowHTTP1: true,
    http1Options: { keepAliveTimeout: IDLE_CONNECTION_MS },
    settings: { initialWindowSize: WINDOW_BYTES },
  });
  server.on('request', proxy(router));
  server.on('upgrade', upgrade(router));
  server.on('session', (session) => {
    session.setLocalWindowSize(WINDOW_BYTES);
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  return server;
};

/** The public origin on both loopback families, its leaf signed as `signing` says: HTTP/2 (1.1 for
 *  WebSockets), each link shaped, the API prefix to the backend. */
export const startEdge = async (
  upstreams: Upstreams,
  signal: AbortSignal,
  signing: EdgeSigning = {},
): Promise<Edge> => {
  const { key, cert, trust } = await makeEdgeCertificate(signal, signing);
  const router: Router = { upstreams, contexts: new Map(), opened: new WeakSet() };
  const sockets = new Set<Socket>();
  const servers = [
    edgeServer(router, { key, cert }, sockets),
    edgeServer(router, { key, cert }, sockets),
  ] as const;
  const stop = async (): Promise<void> => {
    const closing = servers.map(async (server) => closed(server));
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(closing);
  };
  try {
    const port = await listening(servers[0], 0, '127.0.0.1');
    await listening(servers[1], port, '::1').catch(withoutIpv6);
    return { origin: `https://localhost:${String(port)}`, trust, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
