// An upstream that fails once the edge has sent its answer's head: Chromium must read a failed
// load, as production's reset gives it, never a whole answer it would cache and reuse.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { test } from 'node:test';

import { type Browser, chromium, type Page } from '@playwright/test';

import { type Edge, startEdge } from '../src/stack/edge.ts';
import { browserTrust } from '../src/stack/tls.ts';

const MODULE = 'export const t = 1;\n';

/** A safety bound, not a wait: past it a regression fails the run instead of hanging it. It allows
 *  for Chromium's launch on a busy machine. */
const BOUND_MS = 60_000;

/** A site whose first `/dep.js` sends its head, kept a year, then waits for `cut` to reset it;
 *  every later one is whole. */
const startSite = async (): Promise<{ port: number; cut: () => void; close: () => void }> => {
  const held: Socket[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== '/dep.js') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>cut</title>');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (held.length > 0) {
      response.end(MODULE);
      return;
    }
    response.flushHeaders();
    held.push(request.socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    cut: () => {
      for (const socket of held) {
        socket.resetAndDestroy();
      }
    },
    close: () => {
      server.close();
    },
  };
};

/** What the page reads of `/dep.js`, through the HTTP cache: its text, or that the load failed. */
const read = async (page: Page): Promise<string> =>
  page.evaluate(async () =>
    fetch('/dep.js')
      .then(async (answer) => answer.text())
      .catch(() => 'failed'),
  );

/** Chromium on `edge`'s first page, trusting it as the stack's browsers do. */
const pageOn = async (edge: Edge): Promise<{ browser: Browser; page: Page }> => {
  const { args, ignoreHTTPSErrors } = browserTrust(edge.trust, 'chromium');
  const browser = await chromium.launch({ args: [...args] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors });
    const page = await context.newPage();
    await page.goto(`${edge.origin}/`);
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
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
  'an answer cut after its head fails in Chromium, which fetches it again, never cached',
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
    const { browser, page } = await pageOn(edge);
    context.after(async () => browser.close());
    const said = listened();
    context.after(said.restore);
    const headed = page.waitForResponse((answer) => answer.url().endsWith('/dep.js'));
    const first = read(page);
    await headed;
    // The head has reached the browser, so the upstream's reset comes after it.
    site.cut();
    assert.equal(await first, 'failed');
    assert.ok(
      said.lines.some((line) => line.startsWith('edge proxy: upstream ')),
      said.lines.join('\n'),
    );
    // Kept a year had it been whole, so only a failed load leaves the cache to fetch it again.
    assert.equal(await read(page), MODULE);
  },
);
