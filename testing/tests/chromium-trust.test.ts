// Chromium launched here checks the edge's certificate by its leaf's key, as a browser checks
// production's, and refuses an edge whose leaf is another's.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import { startEdge } from '../src/stack/edge.ts';
import { browserTrust } from '../src/stack/tls.ts';

await test('Chromium launched with the edge key switch loads the edge, and refuses another', async () => {
  const { signal } = new AbortController();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>edge</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const site = typeof address === 'object' && address !== null ? address.port : 0;
  const upstreams = { site, api: undefined, cacheControl: undefined, siteHost: undefined };
  const [edge, other] = await Promise.all([
    startEdge(upstreams, signal),
    startEdge(upstreams, signal),
  ]);
  const { args, ignoreHTTPSErrors } = browserTrust(edge.trust, 'chromium');
  const browser = await chromium.launch({ args: [...args] });
  try {
    assert.equal(ignoreHTTPSErrors, false);
    const context = await browser.newContext({ ignoreHTTPSErrors });
    const page = await context.newPage();
    await page.goto(`${edge.origin}/`);
    assert.equal(await page.title(), 'edge');
    await assert.rejects(page.goto(`${other.origin}/`));
  } finally {
    await browser.close();
    await Promise.all([edge.stop(), other.stop()]);
    server.close();
  }
});
