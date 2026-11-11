// WebKit in the Linux image trusts an edge on the local CA as a browser trusts production, so an
// immutable asset comes from its cache on the next load, and refuses an edge on any other CA. The
// image's server makes a context's own requests, so its Node trusts the same CA and no other.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type Browser, webkit } from '@playwright/test';

import { startBrowserServer } from '../src/stack/browsers.ts';
import { startEdge, type Upstreams } from '../src/stack/edge.ts';
import { browserTrust } from '../src/stack/tls.ts';
import { startedAll } from './started.ts';

const PAGE = '<!doctype html><title>t</title><script src="/_astro/app.js"></script>';
const ASSET = '/_astro/app.js';

/** A site serving a page and its one hashed script, counting what it is asked for by path. */
const startSite = async (): Promise<{
  port: number;
  asked: Map<string, number>;
  close: () => void;
}> => {
  const asked = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    asked.set(url, (asked.get(url) ?? 0) + 1);
    const script = url === ASSET;
    response.writeHead(200, {
      'content-type': script ? 'text/javascript' : 'text/html',
      etag: script ? '"app-v1"' : '"page-v1"',
    });
    response.end(script ? 'globalThis.ran = true;' : PAGE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    asked,
    close: () => {
      server.close();
    },
  };
};

/** The production edge's rule: a hashed asset is cached for good, a page revalidated. */
const upstreamsOf = (site: number): Upstreams => ({
  site,
  api: undefined,
  cacheControl: (asked, status) =>
    status === 200 && asked.startsWith('/_astro/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  siteHost: undefined,
});

/** Loads `origin`'s page twice in one context, its script run each time. */
const loadTwice = async (
  browser: Browser,
  origin: string,
  ignoreHTTPSErrors: boolean,
): Promise<void> => {
  const context = await browser.newContext({ ignoreHTTPSErrors });
  const page = await context.newPage();
  const load = async (): Promise<void> => {
    await page.goto(`${origin}/`);
    assert.equal(await page.evaluate((): unknown => Reflect.get(globalThis, 'ran')), true);
  };
  await load();
  await load();
  await context.close();
};

/** Asks for `origin`'s page in a fresh context, which must refuse its certificate. */
const refused = async (
  browser: Browser,
  origin: string,
  ignoreHTTPSErrors: boolean,
): Promise<void> => {
  const context = await browser.newContext({ ignoreHTTPSErrors });
  const page = await context.newPage();
  await assert.rejects(page.goto(`${origin}/`));
  await context.close();
};

/** What a fresh context's `route.fetch` of `origin`'s page, made by the image's Node, answers. */
const routeFetched = async (
  browser: Browser,
  origin: string,
  ignoreHTTPSErrors: boolean,
): Promise<string> => {
  const context = await browser.newContext({ ignoreHTTPSErrors });
  const { promise, resolve } = Promise.withResolvers<string>();
  await context.route(`${origin}/`, async (route) => {
    resolve(
      await route.fetch().then(
        async (response) => {
          await route.fulfill({ response });
          return String(response.status());
        },
        async (error: unknown) => {
          await route.abort();
          return String(error);
        },
      ),
    );
  });
  const page = await context.newPage();
  // A refused fetch aborts the navigation, so the fetch's own status or error is what's told.
  await page.goto(`${origin}/`).catch(() => '');
  const fetched = await promise;
  await context.close();
  return fetched;
};

/** What a fresh context's own request for `origin`'s page, made by the image's Node too, answers:
 *  its status, or why it failed. */
const requested = async (
  browser: Browser,
  origin: string,
  ignoreHTTPSErrors: boolean,
): Promise<string> => {
  const context = await browser.newContext({ ignoreHTTPSErrors });
  try {
    return await context.request
      .get(`${origin}/`)
      .then((response) => String(response.status()), String);
  } finally {
    await context.close();
  }
};

const REFUSED = /unable to verify the first certificate/u;

await test("WebKit in the Linux image and its server's requests trust the local CA, so an immutable asset is cached, and refuse another CA's edge", async () => {
  const { signal } = new AbortController();
  const folder = await mkdtemp(path.join(tmpdir(), 'webkit-trust-'));
  const caDir = path.join(folder, 'edge-ca');
  const site = await startSite();
  const started = startedAll([
    startBrowserServer(signal, caDir),
    startEdge(upstreamsOf(site.port), signal, { localCa: caDir }),
    startEdge(upstreamsOf(site.port), signal),
  ]);
  const [server, trusted, other] = await started.catch(async (error: unknown) => {
    site.close();
    await rm(folder, { recursive: true, force: true });
    throw error;
  });
  const browser = await webkit.connect(server.endpoints.webkit);
  try {
    const { ignoreHTTPSErrors } = browserTrust(trusted.trust, 'webkit', true);
    assert.equal(ignoreHTTPSErrors, false);
    await loadTwice(browser, trusted.origin, ignoreHTTPSErrors);
    assert.deepEqual([site.asked.get('/'), site.asked.get(ASSET)], [2, 1]);
    await refused(browser, other.origin, ignoreHTTPSErrors);
    const answers = await Promise.all(
      [routeFetched, requested].flatMap((ask) =>
        [trusted.origin, other.origin].map(async (origin) =>
          ask(browser, origin, ignoreHTTPSErrors),
        ),
      ),
    );
    assert.deepEqual(
      answers.map((answer) => (REFUSED.test(answer) ? 'refused' : answer)),
      ['200', 'refused', '200', 'refused'],
    );
  } finally {
    await browser.close();
    await Promise.all([server.stop(), trusted.stop(), other.stop()]);
    site.close();
    await rm(folder, { recursive: true, force: true });
  }
});
