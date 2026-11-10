// A full pool of browser contexts in the Linux image, one per seat, loading one page at once
// through the edge on 3G: each loads, none stalled.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type Browser, webkit } from '@playwright/test';

import { joinEdge } from '../src/edge-client.ts';
import { BROWSER_SEATS, startBrowserServer } from '../src/stack/browsers.ts';
import { startEdge } from '../src/stack/edge.ts';
import { browserTrust } from '../src/stack/tls.ts';

const CONTEXTS = BROWSER_SEATS;
const SCRIPTS = Array.from({ length: 25 }, (_none, at) => `/_astro/s${String(at)}.js`);
const PAGE = `<!doctype html><title>t</title>${SCRIPTS.map((src) => `<script src="${src}"></script>`).join('')}`;
const SCRIPT = `globalThis.loaded = (globalThis.loaded ?? 0) + 1; // ${'x'.repeat(18_000)}`;

/** A site of one page and its 25 scripts, about an app page's weight. */
const startSite = async (): Promise<{ port: number; close: () => void }> => {
  const server = createServer((request, response) => {
    const script = (request.url ?? '/').startsWith('/_astro/');
    response.writeHead(200, { 'content-type': script ? 'text/javascript' : 'text/html' });
    response.end(script ? SCRIPT : PAGE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => {
      server.close();
    },
  };
};

/** How many scripts each of `CONTEXTS` contexts ran, all loading `origin` at once on 3G. */
const loadedAtOnce = async (browser: Browser, origin: string): Promise<number[]> => {
  const { ignoreHTTPSErrors } = browserTrust({ ca: '', spki: '' }, 'webkit', true);
  const contexts = await Promise.all(
    Array.from({ length: CONTEXTS }, async () =>
      browser.newContext({ baseURL: origin, ignoreHTTPSErrors }),
    ),
  );
  await Promise.all(contexts.map(async (context) => joinEdge(context, origin, '3g')));
  const pages = await Promise.all(contexts.map(async (context) => context.newPage()));
  await Promise.all(pages.map(async (page) => page.goto('/')));
  const loaded = await Promise.all(
    pages.map(async (page) => page.evaluate((): unknown => Reflect.get(globalThis, 'loaded'))),
  );
  await Promise.all(contexts.map(async (context) => context.close()));
  return loaded.map(Number);
};

await test(`${String(CONTEXTS)} contexts in the Linux image load a page at once, none stalled`, async () => {
  const { signal } = new AbortController();
  const folder = await mkdtemp(path.join(tmpdir(), 'contexts-test-'));
  const caDir = path.join(folder, 'edge-ca');
  const site = await startSite();
  const upstreams = {
    site: site.port,
    api: undefined,
    cacheControl: (): string => 'no-cache',
    siteHost: undefined,
  };
  const [server, edge] = await Promise.all([
    startBrowserServer(signal, caDir),
    startEdge(upstreams, signal, { localCa: caDir }),
  ]);
  const browser = await webkit.connect(server.wsEndpoint, { exposeNetwork: '<loopback>' });
  try {
    assert.deepEqual(
      await loadedAtOnce(browser, edge.origin),
      Array.from({ length: CONTEXTS }, () => SCRIPTS.length),
    );
  } finally {
    await browser.close();
    await Promise.all([server.stop(), edge.stop()]);
    site.close();
    await rm(folder, { recursive: true, force: true });
  }
});
