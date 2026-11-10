// Firefox's bounce-tracking protection, under the kit's launch: a page left before it loads, a
// hop through its site, is still classified as a bounce tracker; a page whose load outlasts
// Firefox's own client-bounce timer, then finishes, is not. Every step is bounded, and a step
// that fails closes its browser, so a test that can't end fails instead of holding its run.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { firefox, type Page } from '@playwright/test';

import { launchOf } from '../src/config.ts';

const CLASSIFIED = '“localhost” has been classified as a bounce tracker';

/** Firefox's own client-bounce timer, which the kit's launch outlasts. */
const FIREFOX_TIMER_MS = 10_000;

/** The longest a step may take: past it the step fails, and its browser closes. */
const STEP_MS = 60_000;

interface Sites {
  /** A page on 127.0.0.1 that loads at once: a site of its own to start from. */
  readonly ready: string;
  /** A page on localhost whose one image is held until `release`, so its load waits. */
  readonly held: string;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}

const serve = async (): Promise<Sites> => {
  const waiting: ServerResponse[] = [];
  const state = { released: false };
  const server = createServer((request, response) => {
    if (request.url === '/held.png' && !state.released) {
      waiting.push(response);
      return;
    }
    const page = request.url === '/held' ? '<img src="/held.png" alt="">' : '';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>page</title>${page}`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = String(address.port);
  const release = (): void => {
    state.released = true;
    for (const response of waiting.splice(0)) {
      if (!response.destroyed) {
        response.writeHead(204).end();
      }
    }
  };
  return {
    ready: `http://127.0.0.1:${port}/ready`,
    held: `http://localhost:${port}/held`,
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
};

/** Runs `steps` on a page of a fresh Firefox launched as the kit does, with the sites and the
 *  bounce-tracker warnings; the browser and the sites close however it ends. */
const inFirefox = async (
  steps: (page: Page, sites: Sites, warnings: readonly string[]) => Promise<void>,
): Promise<void> => {
  const sites = await serve();
  const browser = await firefox.launch(Object.assign(launchOf('firefox'), { timeout: STEP_MS }));
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_MS);
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes(CLASSIFIED)) {
        warnings.push(message.text());
      }
    });
    await steps(page, sites, warnings);
  } finally {
    await browser.close();
    await sites.close();
  }
};

await test('under the kit’s launch, a page left before it loads is still a bounce', async () => {
  await inFirefox(async (page, sites) => {
    await page.goto(sites.ready);
    await page.goto(sites.held, { waitUntil: 'commit' });
    const classified = page.waitForEvent('console', {
      predicate: (message) => message.text().includes(CLASSIFIED),
    });
    // Left for another site while its image is still held: a hop through localhost.
    await page.goto(sites.ready);
    await classified;
  });
});

await test('under the kit’s launch, a load that outlasts Firefox’s own timer is no bounce', async () => {
  await inFirefox(async (page, sites, warnings) => {
    await page.goto(sites.held, { waitUntil: 'commit' });
    // Half as long again as Firefox's own timer: without the kit's pref, it would have run out on
    // a load still waiting.
    await new Promise((resolve) => {
      setTimeout(resolve, 1.5 * FIREFOX_TIMER_MS);
    });
    sites.release();
    await page.waitForLoadState('load');
    assert.deepEqual(warnings, [], 'no slow load is a bounce');
  });
});
