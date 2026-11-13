// An image the page abandons as it leaves is no fault in any engine, though Firefox calls it
// corrupt or truncated; an image that does arrive truncated still is.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { type BrowserType, chromium, firefox, type Page, webkit } from '@playwright/test';

import { watch } from '../src/invariants.ts';

const JPEG = readFileSync(new URL('fixtures/poster.jpg', import.meta.url));
const HALF = JPEG.subarray(0, JPEG.length / 2);

const held: ServerResponse[] = [];
const server = createServer((request, response) => {
  const page = (body: string): void => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html lang="en"><title>t</title><body>${body}</body></html>`);
  };
  if (request.url === '/held.jpg') {
    // Half the image, then nothing: the page leaves while it is still arriving.
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(JPEG.length),
    });
    response.write(HALF);
    held.push(response);
  } else if (request.url === '/half.jpg') {
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(HALF.length),
    });
    response.end(HALF);
  } else if (request.url === '/leaving') {
    page('<img src="/held.jpg" alt=""><a href="/other">Other</a>');
  } else if (request.url === '/broken') {
    page('<img src="/half.jpg" alt="">');
  } else {
    page('<p>Other</p>');
  }
});
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;

/** Firefox's one console error for an image, which the other engines do not report. */
const imageError = async (page: Page, engine: BrowserType): Promise<unknown> =>
  engine === firefox
    ? page.waitForEvent('console', (message) => message.type() === 'error')
    : Promise.resolve();

/** Whether the page's image has its size, which a decoder sets once it has read the image's
 *  headers: Firefox reports an abandoned image only after that. */
const sized = (): boolean => {
  const image = globalThis.document.querySelector('img');
  return image !== null && image.naturalWidth > 0;
};

/** Leaves a page while its image is still arriving, once its decoder has begun on it. */
const leave = async (page: Page, engine: BrowserType): Promise<void> => {
  await page.goto(`${origin}/leaving`, { waitUntil: 'commit' });
  await page.waitForFunction(sized);
  const reported = imageError(page, engine);
  await page.getByRole('link', { name: 'Other' }).click();
  await page.waitForURL(`${origin}/other`);
  await reported;
};

/** Shows a page whose image arrives whole but truncated. */
const broken = async (page: Page, engine: BrowserType): Promise<void> => {
  const reported = imageError(page, engine);
  await page.goto(`${origin}/broken`);
  await reported;
};

try {
  await Promise.all(
    [chromium, firefox, webkit].map(async (engine) =>
      test(`${engine.name()}: an image abandoned on leaving is no fault, a truncated one is`, async () => {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage();
          const invariants = await watch(page, { origin, apiPrefix: undefined, notices: [] });
          await leave(page, engine);
          assert.deepEqual(await invariants.take(), []);
          await broken(page, engine);
          const found = await invariants.take();
          assert.equal(found.length, engine === firefox ? 1 : 0);
          assert.ok(found.every((problem) => problem.includes('/half.jpg')));
        } finally {
          await browser.close();
        }
      }),
    ),
  );
} finally {
  for (const response of held) {
    response.destroy();
  }
  server.close();
}
