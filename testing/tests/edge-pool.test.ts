// The edge's upstream pool under slow links: an answer frees its pooled connection once its
// upstream has sent it, so no context waits on another's link.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { type ClientHttp2Session, connect } from 'node:http2';
import { type TestContext, test } from 'node:test';

import { startEdge } from '../src/stack/edge.ts';
import { CONNECTS_AT_ONCE } from '../src/stack/ports.ts';
import { fetchOver } from './edge-fetch.ts';

/** A safety bound, not a wait: past it a regression fails the run instead of hanging it. */
const BOUND_MS = 30_000;

/** Far past what a stream buffers by default, well within what a link takes ahead. */
const SLOW_BYTES = 512 * 1024;

/** A site that holds each `/slow` until `release` sends them all whole, and answers the rest. */
interface Site {
  readonly port: number;
  /** Settles once the site holds a `/slow` on every pooled connection. */
  readonly pooled: Promise<number>;
  readonly release: () => void;
  readonly close: () => void;
}

const startSite = async (): Promise<Site> => {
  const held: ServerResponse[] = [];
  const pooled = Promise.withResolvers<number>();
  const server = createServer((request, response) => {
    if (request.url !== '/slow') {
      response.end('whole');
      return;
    }
    held.push(response);
    if (held.length === CONNECTS_AT_ONCE) {
      pooled.resolve(held.length);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const release = (): void => {
    for (const response of held.splice(0)) {
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(SLOW_BYTES),
      });
      response.end(Buffer.alloc(SLOW_BYTES));
    }
  };
  const close = (): void => {
    server.closeAllConnections();
    server.close();
  };
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, pooled: pooled.promise, release, close };
};

/** The site, its edge, a client for the held context and one for the rest; all go once the test
 *  ends, a failed one too, so nothing it holds outlives it. */
const startStack = async (
  context: TestContext,
): Promise<{ site: Site; held: ClientHttp2Session; other: ClientHttp2Session }> => {
  const site = await startSite();
  const upstreams = {
    site: site.port,
    api: undefined,
    cacheControl: undefined,
    siteHost: undefined,
  };
  const edge = await startEdge(upstreams, new AbortController().signal);
  const held = connect(edge.origin, { ca: edge.trust.ca });
  const other = connect(edge.origin, { ca: edge.trust.ca });
  context.after(async () => {
    held.destroy();
    other.destroy();
    site.close();
    await edge.stop();
  });
  return { site, held, other };
};

/** Stops the clock the links run on, the performance clock and its timers, for this test. */
const holdLinks = (context: TestContext): void => {
  const now = performance.now();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(performance, 'now', () => now);
};

await test(
  'answers held on a slow link free their upstream connections, so no context waits',
  { timeout: BOUND_MS },
  async (context) => {
    const { site, held, other } = await startStack(context);
    const slowed = Array.from({ length: CONNECTS_AT_ONCE }, () =>
      held.request({ ':path': '/slow', cookie: 'sites-context=wired.held' }, { endStream: true }),
    );
    const heads = { seen: 0 };
    for (const stream of slowed) {
      stream.once('response', () => {
        heads.seen += 1;
      });
    }
    // Every pooled connection is the held context's before its link slows, and then stops.
    await site.pooled;
    const steered = await fetchOver(other, {
      ':path': '/.sites-testing/contexts/held/network/3g',
      ':method': 'POST',
    });
    assert.equal(steered.status, 204);
    holdLinks(context);
    site.release();
    const answered = await fetchOver(other, { ':path': '/', cookie: 'sites-context=wired.other' });
    assert.deepEqual([answered.status, answered.body.toString(), heads.seen], [200, 'whole', 0]);
  },
);
