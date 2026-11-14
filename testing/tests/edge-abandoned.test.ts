// A browser that leaves while its request's body is still crossing the link takes the upstream
// request with it: abandoned traffic, which the edge cuts and never reports as an upstream fault.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, constants } from 'node:http2';
import { test } from 'node:test';

import { CONTEXT_COOKIE } from '../src/network.ts';
import { startEdge } from '../src/stack/edge.ts';

/** More than 3G carries in seconds, so a body is still on its way when its first bytes arrive. */
const BODY = Buffer.alloc(2 * 1024 * 1024);
/** A safety bound, not a wait: past it a regression fails the run instead of hanging it. */
const BOUND_MS = 60_000;

/** An upload's two moments upstream: its first bytes, and its request's end, whole or cut. */
interface Upload {
  readonly arrived: Promise<void>;
  readonly ended: Promise<void>;
}

/** A site that reads every upload and answers once it is whole, telling of the first. */
const startSite = async (): Promise<{
  port: number;
  upload: Promise<Upload>;
  close: () => void;
}> => {
  const server = createServer();
  const upload = new Promise<Upload>((resolve) => {
    server.once('request', (request: IncomingMessage, response) => {
      const arrived = new Promise<void>((done) => {
        request.once('data', () => {
          done();
        });
      });
      const ended = new Promise<void>((done) => {
        request.once('close', () => {
          done();
        });
      });
      request.on('end', () => {
        response.end('stored');
      });
      resolve({ arrived, ended });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    upload,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

/** The lines the edge says from now until `restore`. */
const listened = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const report = console.error;
  console.error = (line: unknown): void => {
    lines.push(String(line));
  };
  return {
    lines,
    restore: () => {
      console.error = report;
    },
  };
};

await test(
  'a browser leaving mid-upload cuts its upstream request, which the edge reports as no fault',
  { timeout: BOUND_MS },
  async (context) => {
    const site = await startSite();
    context.after(site.close);
    const upstreams = {
      site: site.port,
      api: undefined,
      cacheControl: undefined,
      siteHost: undefined,
    };
    const edge = await startEdge(upstreams, new AbortController().signal);
    context.after(async () => edge.stop());
    const session = connect(edge.origin, { ca: edge.trust.ca });
    context.after(() => {
      session.close();
    });
    const said = listened();
    context.after(said.restore);
    const stream = session.request({
      ':method': 'POST',
      ':path': '/notes',
      cookie: `${CONTEXT_COOKIE}=3g.leaving`,
    });
    const cancelled: string[] = [];
    stream.on('error', (error: Error) => {
      cancelled.push(error.message);
    });
    stream.end(BODY);
    const upload = await site.upload;
    await upload.arrived;
    // Left as a browser leaves a page, with most of the body still crossing the link.
    stream.close(constants.NGHTTP2_CANCEL);
    // The edge cut its upstream request before the site can read that the connection closed.
    await upload.ended;
    assert.deepEqual(said.lines, []);
  },
);
