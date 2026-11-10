// An axe-core scan reads a page at rest, in every engine: an overlay's, its theme turned once it
// was shown whole and while axe-core loads, waits for the panel's fade to end; a screen's, its
// theme turned as the scan reads, runs again once the fade has ended. Each judges the colours the
// page settles at, not the ones it passes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Browser, chromium, firefox, type Page, webkit } from '@playwright/test';

import { AXE, axeFindings, STRICTEST } from '../src/checks/axe.ts';
import { overlaysHeld, overlayWatchScript } from '../src/checks/overlays.ts';

/** Where the watched page is served, by a route: nothing leaves the browser. */
const FIXTURE = 'https://at-rest.test/';

/** A panel whose text turns light with the theme at once while its grey darkens over a fade, as a
 *  dialog's does: white text fails contrast on the first grey and passes on the dark one. */
const PAGE = `<!doctype html><html lang="en"><head><title>At rest</title><style>
body { margin: 0; font: 16px sans-serif; background: #fff; color: #000 }
.panel { background: #ddd; color: #000; transition: background-color 2s steps(1, end) }
.dark .panel { background: #333; color: #fff }
</style></head><body><main class="panel"><h1>At rest</h1><p>What the scan reads.</p></main>
<dialog class="panel" aria-labelledby="t"><h2 id="t">Your theme</h2><p>What the scan reads.</p>
</dialog></body></html>`;

/** What axe-core finds in the dialog the page watch opens, its theme turned as axe-core loads, once
 *  every hold and the last finding's round trip have ended; its layout is another rule's. */
const turnedAsItLoads = async (page: Page): Promise<void> => {
  const [heard, shown, moving]: [string[], string[], number[]] = [[], [], []];
  const suffix = String(Math.random()).slice(2);
  const [binding, load, report] = [`shown${suffix}`, `load${suffix}`, `axe${suffix}`];
  await page.exposeFunction(binding, (finding: string) => {
    shown.push(finding);
  });
  await page.exposeBinding(load, async ({ frame }) => {
    await frame.evaluate(AXE);
    const turned = await frame.evaluate(() => {
      globalThis.document.documentElement.classList.add('dark');
      return globalThis.document.getAnimations().length;
    });
    moving.push(turned);
  });
  await page.exposeFunction(report, (finding: string) => {
    heard.push(finding);
  });
  const audit = { load, report, options: STRICTEST };
  await page.addInitScript({ content: overlayWatchScript({ binding, audit }) });
  await page.route(FIXTURE, async (route) =>
    route.fulfill({ body: PAGE, contentType: 'text/html' }),
  );
  await page.goto(FIXTURE);
  await page.evaluate(() => {
    const dialog = globalThis.document.querySelector('dialog');
    if (dialog !== null) {
      dialog.showModal();
    }
  });
  await page.evaluate(overlaysHeld);
  await page.evaluate(() => 0);
  assert.deepEqual(moving, [2], 'the panels were on their way to dark as the scan was due');
  assert.deepEqual(heard, []);
};

/** What axe-core finds on the screen, the theme turned at the first style its first run reads. */
const turnedAsItReads = async (page: Page): Promise<void> => {
  await page.setContent(PAGE);
  await page.evaluate(AXE);
  await page.evaluate(() => {
    const { axe, document } = globalThis;
    const [run, read] = [axe.run, globalThis.getComputedStyle];
    const seen = { runs: 0, moving: 0 };
    const armed = { turn: false };
    Reflect.set(globalThis, Symbol.for('at-rest.seen'), seen);
    Reflect.set(globalThis, 'getComputedStyle', (...args: Parameters<typeof read>) => {
      if (armed.turn) {
        armed.turn = false;
        document.documentElement.classList.add('dark');
        seen.moving = document.getAnimations().length;
      }
      return Reflect.apply(read, globalThis, args);
    });
    Reflect.set(axe, 'run', async (...args: Parameters<typeof run>) => {
      seen.runs += 1;
      armed.turn = seen.runs === 1;
      return Reflect.apply(run, axe, args);
    });
  });
  assert.deepEqual(await axeFindings(page), []);
  assert.deepEqual(
    await page.evaluate((): unknown => Reflect.get(globalThis, Symbol.for('at-rest.seen'))),
    { runs: 2, moving: 1 },
    'the first run read the panel on its way to dark, and a second read it there',
  );
};

/** What axe-core finds once a fade starts, unheard, and ends within its first run, as WebKit tells
 *  no start for a popover's entry: an ended fade is not listed, so only its end tells. */
const movedWithinRun = async (page: Page): Promise<void> => {
  await page.setContent(PAGE);
  await page.evaluate(AXE);
  await page.evaluate(() => {
    const { axe, document } = globalThis;
    const { run } = axe;
    const seen = { runs: 0 };
    Reflect.set(globalThis, Symbol.for('at-rest.moved'), seen);
    globalThis.addEventListener(
      'transitionrun',
      (event) => {
        event.stopImmediatePropagation();
      },
      { capture: true },
    );
    Reflect.set(axe, 'run', async (...args: Parameters<typeof run>) => {
      seen.runs += 1;
      const results = await Reflect.apply(run, axe, args);
      if (seen.runs === 1) {
        const ended = new Promise((resolve) => {
          document.addEventListener('transitionend', resolve, { once: true });
        });
        document.documentElement.classList.add('dark');
        for (const fade of document.getAnimations()) {
          fade.finish();
        }
        await ended;
      }
      return results;
    });
  });
  assert.deepEqual(await axeFindings(page), []);
  assert.deepEqual(
    await page.evaluate((): unknown => Reflect.get(globalThis, Symbol.for('at-rest.moved'))),
    { runs: 2 },
    'the fade began and ended within the first run, so a second read the page at rest',
  );
};

await Promise.all(
  [chromium, firefox, webkit].map(async (engine) =>
    test(`${engine.name()}: a scan judges the colours a turning theme ends at`, async (context) => {
      const browser: Browser = await engine.launch();
      try {
        await context.test("an overlay's scan due mid-fade waits for its end", async () =>
          turnedAsItLoads(await browser.newPage()),
        );
        await context.test("a screen's scan the fade began in runs again after it", async () =>
          turnedAsItReads(await browser.newPage()),
        );
        await context.test(
          'a scan a fade began and ended in, its start unheard, runs again',
          async () => movedWithinRun(await browser.newPage()),
        );
      } finally {
        await browser.close();
      }
    }),
  ),
);
