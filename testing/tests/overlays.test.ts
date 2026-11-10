// Overlays shown whole, on fixed pages in a real browser: the layout rule on dialogs and popovers
// as they stand, and the page watch on each as it opens, its entry played or not, and axe-core
// on it once it is shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Browser, chromium, type Page } from '@playwright/test';

import { AXE, STRICTEST } from '../src/checks/axe.ts';
import { layoutFindings } from '../src/checks/layout.ts';
import {
  overlayOpeningScript,
  overlaysHeld,
  type OverlayWatch,
  overlayWatchScript,
} from '../src/checks/overlays.ts';

/** Where the watched pages are served, by a route: nothing leaves the browser. */
const FIXTURE = 'https://overlays.test/';

const PANEL = '<div><h2 id="t">What is on board</h2><p>One line of content.</p></div>';

/** A page with one dialog styled `style`, and a popover with no heading but its button. */
const pageOf = (style: string): string => `<!doctype html><html><head><style>
  dialog { padding: 0; border: 0; width: 20rem; ${style} }
  dialog::backdrop { background: rgb(0 0 0 / 50%); }
</style></head><body style="margin:0;font:16px sans-serif">
<dialog id="d" aria-labelledby="t">${PANEL}</dialog>
<div id="p" popover><button type="button">Only a button</button></div>
</body></html>`;

/** In the page: opens its dialog as a modal, where it has one. */
const showDialog = (): void => {
  const dialog = globalThis.document.querySelector('dialog');
  if (dialog !== null) {
    dialog.showModal();
  }
};

const findingsOf = async (page: Page, style: string): Promise<readonly string[]> => {
  await page.setContent(pageOf(style));
  await page.evaluate(showDialog);
  const { overlays } = await layoutFindings(page, { touch: false, toasts: undefined });
  return overlays;
};

const rule = async (page: Page): Promise<void> => {
  assert.deepEqual(await findingsOf(page, ''), []);
  const collapsed = await findingsOf(page, 'height: 0; overflow: hidden;');
  assert.ok(collapsed.some((finding) => finding.includes('under 2rem')));
  assert.ok(collapsed.some((finding) => finding.includes('heading lies outside')));
  const faded = await findingsOf(page, 'opacity: 0;');
  assert.ok(faded.includes('<dialog> "What is on board" is drawn at opacity 0.00'));
  assert.ok(faded.includes('<dialog> "What is on board" is open yet not visible'));
  await page.evaluate(() => {
    const popover = globalThis.document.querySelector<HTMLElement>('#p');
    if (popover !== null) {
      popover.showPopover();
    }
  });
  const both = await layoutFindings(page, { touch: false, toasts: undefined });
  assert.ok(both.overlays.every((finding) => finding.startsWith('<dialog>')));
};

/** Opens the dialog of `body` under the page watch, once every hold has ended. */
const openWatched = async (page: Page, watching: OverlayWatch, body: string): Promise<void> => {
  await page.addInitScript({ content: overlayWatchScript(watching) });
  await page.route(FIXTURE, async (route) => route.fulfill({ body, contentType: 'text/html' }));
  await page.goto(FIXTURE);
  await page.evaluate(showDialog);
  await page.evaluate(overlaysHeld);
  // One more round trip, so the last finding handed over has been answered.
  await page.evaluate(() => 0);
};

/** The findings the page watch hands over for one dialog opened under `style`. */
const watched = async (page: Page, style: string): Promise<readonly string[]> => {
  const heard: string[] = [];
  const binding = `heard${String(Math.random()).slice(2)}`;
  await page.exposeFunction(binding, (finding: string) => {
    heard.push(finding);
  });
  await openWatched(page, { binding }, pageOf(style));
  return heard;
};

const watch = async (page: Page): Promise<void> => {
  const entry =
    'transition: opacity .15s ease-out, scale .15s ease-out; &[open] { @starting-style { opacity: 0; scale: .95; } }';
  assert.deepEqual(await watched(page, entry), []);
};

const watchHidden = async (page: Page): Promise<void> => {
  const found = await watched(page, 'opacity: 0; transition: opacity .15s;');
  assert.ok(found.includes('<dialog> "What is on board" is drawn at opacity 0.00'));
};

/** The opening driver on a page with a dialog behind a shown trigger and a popover behind a
 *  hidden one: the dialog opened, its entry timed, the popover left. */
const opening = async (page: Page): Promise<void> => {
  const entry = 'transition: opacity .15s ease-out; &[open] { @starting-style { opacity: 0; } }';
  const triggers = `<button type="button" command="show-modal" commandfor="d">Open</button>
<button type="button" popovertarget="p" hidden>Menu</button>`;
  await page.setContent(
    pageOf(entry).replace('<body', `<body>${triggers}<div`).replace('</body>', '</div></body>'),
  );
  const answer = await page.evaluate<string>(`(async () => {\n${overlayOpeningScript()}\n})()`);
  const opened: unknown = JSON.parse(answer);
  assert.ok(Array.isArray(opened), answer);
  assert.equal(opened.length, 1, answer);
  const dialog: unknown = opened[0];
  assert.ok(typeof dialog === 'object' && dialog !== null);
  assert.equal(Reflect.get(dialog, 'id'), 'd', answer);
  assert.deepEqual(Reflect.get(dialog, 'findings'), [], answer);
  const took: unknown = Reflect.get(dialog, 'entry');
  assert.ok(typeof took === 'number' && took >= 150, answer);
};

/** What axe-core finds in a dialog holding `panel`, as the page watch opens it. */
const audited = async (page: Page, panel: string): Promise<readonly string[]> => {
  const [heard, shown]: [string[], string[]] = [[], []];
  const suffix = String(Math.random()).slice(2);
  const [binding, load, report] = [`shown${suffix}`, `load${suffix}`, `axe${suffix}`];
  // What keeps the dialog from being shown whole is the layout rule's to judge, not this test's.
  await page.exposeFunction(binding, (finding: string) => {
    shown.push(finding);
  });
  await page.exposeBinding(load, async ({ frame }) => {
    await frame.evaluate(AXE);
  });
  await page.exposeFunction(report, (finding: string) => {
    heard.push(finding);
  });
  const body = pageOf('').replace(PANEL, `<div><h2 id="t">What is on board</h2>${panel}</div>`);
  await openWatched(page, { binding, audit: { load, report, options: STRICTEST } }, body);
  return heard;
};

const audit = async (browser: Browser): Promise<void> => {
  assert.deepEqual(await audited(await browser.newPage(), '<p>One line of content.</p>'), []);
  const found = await audited(await browser.newPage(), '<button type="button"></button>');
  assert.ok(
    found.some((finding) => finding.startsWith('button-name ')),
    found.join('\n'),
  );
};

/** What the page watch hands over for a dialog taken off the page, still open, while axe-core
 *  loads for it: nothing, as for one closed. */
const removedWhileHeld = async (page: Page): Promise<void> => {
  const heard: string[] = [];
  const removed: boolean[] = [];
  const suffix = String(Math.random()).slice(2);
  const [binding, load, report] = [`shown${suffix}`, `load${suffix}`, `axe${suffix}`];
  const hear = (finding: string): void => {
    heard.push(finding);
  };
  await page.exposeFunction(binding, hear);
  await page.exposeBinding(load, async ({ frame }) => {
    await frame.evaluate(AXE);
    removed.push(
      await frame.evaluate(() => {
        const dialog = globalThis.document.querySelector('dialog');
        if (dialog === null) {
          return false;
        }
        dialog.remove();
        return dialog.open;
      }),
    );
  });
  await page.exposeFunction(report, hear);
  await openWatched(page, { binding, audit: { load, report, options: STRICTEST } }, pageOf(''));
  assert.deepEqual(removed, [true], 'the dialog left the page open, as its audit was due');
  assert.deepEqual(heard, []);
};

await test('overlays shown whole in a browser', async (context) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await context.test('the layout rule finds a collapsed or see-through dialog', async () =>
      rule(page),
    );
    await context.test('the page watch passes an entry that fades in', async () =>
      watch(await browser.newPage()),
    );
    await context.test('the page watch finds a dialog that stays see-through', async () =>
      watchHidden(await browser.newPage()),
    );
    await context.test('the opening driver opens what a shown trigger names', async () =>
      opening(await browser.newPage()),
    );
    await context.test('the page watch holds each opened dialog to axe-core', async () =>
      audit(browser),
    );
    await context.test('the page watch lets go of a dialog taken off the page open', async () =>
      removedWhileHeld(await browser.newPage()),
    );
  } finally {
    await browser.close();
  }
});
