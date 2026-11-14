// A whole-page capture on a touch screen, as the visual baselines take one: drawn as the phone lays
// the page out, its coarse-pointer rules in force to the last row, and the viewport given back.
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type Browser, chromium, type Page } from '@playwright/test';

import { untilStill } from '../src/checks/still.ts';
import { diffSummary } from '../src/checks/visual-diff.ts';
import { atPageHeight, reasonOf, VISUAL_MOTION, verdictOf } from '../src/visual.ts';

const VIEWPORT = { width: 360, height: 600 };

/** Twelve rows a finger's height on a coarse pointer, else a mouse's; `finger` fixes the finger's.
 *  On a coarse pointer the page is 1,014 px tall, on a fine one 534, inside the viewport. */
const rowsOf = (height: 'pointer' | 'finger'): string => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; }
  p { margin: 0; height: ${height === 'finger' ? '80px' : '40px'}; border-bottom: 2px solid #123; }
  @media (pointer: coarse) { p { height: 80px; } }
  p:nth-child(odd) { background: #9cf; }
  footer { height: 30px; background: #c00; }
</style></head><body>${'<p></p>'.repeat(12)}<footer></footer></body></html>`;

const phone = async (browser: Browser, hasTouch: boolean): Promise<Page> =>
  browser.newPage({ viewport: VIEWPORT, isMobile: hasTouch, hasTouch, deviceScaleFactor: 1 });

/** Counts the page's viewport resizes from now on. */
const counted = (page: Page): (() => number) => {
  const resize = page.setViewportSize.bind(page);
  const state = { resizes: 0 };
  page.setViewportSize = async (size): Promise<void> => {
    state.resizes += 1;
    await resize(size);
  };
  return () => state.resizes;
};

const title = async (page: Page): Promise<string> => page.title();

const dim = (text: string): string => `\u001B[2m${text}\u001B[22m`;

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'visual-'));
const saved = async (name: string, png: Buffer): Promise<string> => {
  const file = path.join(temporary.path, name);
  await writeFile(file, png);
  return file;
};

/** Once Chromium has drawn the page as it now stands: a second frame has begun, so the first was
 *  drawn. A screenshot copies the frame last drawn, and a change may have none drawn yet. */
const drawn = async (page: Page): Promise<void> => {
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => {
          globalThis.requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
};

const wholePage = async (page: Page): Promise<Buffer> => {
  await drawn(page);
  return page.screenshot({ fullPage: true, animations: 'disabled' });
};

/** The viewport's shot, once drawn as the page now stands. */
const viewportShot = async (page: Page): Promise<Buffer> => {
  await drawn(page);
  return page.screenshot({ animations: 'disabled' });
};

await test('a touch page taller than its viewport is captured as the phone lays it out', async () => {
  const browser = await chromium.launch();
  try {
    const page = await phone(browser, true);
    const resizes = counted(page);
    await page.setContent(rowsOf('finger'));
    const real = await saved('real.png', await wholePage(page));
    await page.setContent(rowsOf('pointer'));
    const captured = await atPageHeight(page, async () => wholePage(page));
    assert.equal(
      diffSummary(real, await saved('captured.png', captured)),
      'no pixel differs over the shared area',
    );
    assert.deepEqual([page.viewportSize(), resizes()], [VIEWPORT, 2]);
    assert.ok(await page.evaluate(() => globalThis.matchMedia('(pointer: coarse)').matches));
  } finally {
    await browser.close();
  }
});

await test('the viewport is given back when the capture fails', async () => {
  const browser = await chromium.launch();
  try {
    const page = await phone(browser, true);
    await page.setContent(rowsOf('pointer'));
    await assert.rejects(
      atPageHeight(page, async () => {
        await page.evaluate(() => {
          throw new Error('the capture failed');
        });
      }),
      /the capture failed/u,
    );
    assert.deepEqual(page.viewportSize(), VIEWPORT);
    assert.equal(await page.evaluate(() => globalThis.innerHeight), VIEWPORT.height);
  } finally {
    await browser.close();
  }
});

/** A page taller than the viewport, whose `block` the viewport moves or sizes. */
const movedBy = (block: string): string => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">${block}<p style="margin:0;height:900px"></p></body></html>`;

await test('a page the taller viewport would move, outgrow or not hold fails the capture, named, uncaptured', async () => {
  const browser = await chromium.launch();
  try {
    const blocks = [
      [
        '<aside id="half" style="position:fixed;top:0;width:10px;height:50dvh"></aside>',
        /<aside#half> from 0\.0 0\.0 10\.0 300\.0 to 0\.0 0\.0 10\.0 450\.0/u,
      ],
      [
        '<nav id="bar" style="position:fixed;bottom:0;height:40px;width:100%"></nav>',
        /<nav#bar> from 0\.0 560\.0 360\.0 40\.0 to 0\.0 860\.0/u,
      ],
      [
        '<div style="height:100vh"></div><footer style="height:40px"></footer>',
        /the page, 360×2480, outgrows the viewport grown to it, 360×1540/u,
      ],
      [
        '<div style="width:500px;height:10px"></div>',
        /the page, 500×910, is wider than its 360×600 touch screen/u,
      ],
    ] as const;
    const captures = { taken: 0 };
    await Promise.all(
      blocks.map(async ([block, named]) => {
        const page = await phone(browser, true);
        await page.setContent(movedBy(block));
        await assert.rejects(
          atPageHeight(page, async () => {
            captures.taken += 1;
            return title(page);
          }),
          named,
        );
        assert.deepEqual(page.viewportSize(), VIEWPORT);
      }),
    );
    assert.equal(captures.taken, 0);
  } finally {
    await browser.close();
  }
});

await test('a page scrolled before the capture is scrolled back after it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await phone(browser, true);
    await page.setContent(rowsOf('pointer'));
    await page.evaluate(() => {
      globalThis.scrollTo(0, 200);
    });
    await atPageHeight(page, async () => title(page));
    assert.equal(await page.evaluate(() => globalThis.scrollY), 200);
  } finally {
    await browser.close();
  }
});

await test('a page that fits its viewport, or has no touch, is captured as it stands', async () => {
  const browser = await chromium.launch();
  try {
    const [touch, mouse] = [await phone(browser, true), await phone(browser, false)];
    const resizes = [counted(touch), counted(mouse)];
    await touch.setContent(
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0"><p style="margin:0;height:${String(VIEWPORT.height)}px"></p></body>`,
    );
    await mouse.setContent(rowsOf('finger'));
    assert.equal(await atPageHeight(touch, async () => title(touch)), '');
    assert.equal(await atPageHeight(mouse, async () => title(mouse)), '');
    assert.deepEqual(
      resizes.map((count) => count()),
      [0, 0],
    );
  } finally {
    await browser.close();
  }
});

await test('a capture that failed is told in its own words and its last failed capture, its call log otherwise left out', () => {
  const failed = new Error(
    `${dim('expect(')}page${dim(').toHaveScreenshot(')}expected${dim(')')} failed\n\n  Timeout: 5000ms\n` +
      '  Failed to take two consecutive stable screenshots.\n\nCall log:\n  - waiting for the page',
  );
  assert.equal(
    reasonOf(failed),
    'expect(page).toHaveScreenshot(expected) failed Timeout: 5000ms Failed to take two consecutive stable screenshots.',
  );
  assert.equal(reasonOf('the page closed'), 'the page closed');
  const threw = new Error(
    'expect(page).toHaveScreenshot(expected) failed\n\n  Timeout 5000ms exceeded.\n\nCall log:\n' +
      '  - taking page screenshot\n  - failed to take screenshot - a first reason\n' +
      '  - failed to take screenshot - Protocol error: the texture is too large',
  );
  assert.equal(
    reasonOf(threw),
    'expect(page).toHaveScreenshot(expected) failed Timeout 5000ms exceeded. failed to take screenshot - Protocol error: the texture is too large',
  );
});

/** A modal as the kit's dialogs open: faded and grown in unless motion is reduced, over a blur, at
 *  a width whose centre falls between pixels. */
const DIALOG = `<!doctype html><html><head><style>
  html { font-size: 110%; font-family: sans-serif; color-scheme: light dark; }
  dialog { position: fixed; inset: 0; margin: auto; width: 42rem; border: 0; background: Canvas; }
  @media (prefers-reduced-motion: no-preference) {
    dialog { transition: opacity 0.15s ease-out, scale 0.15s ease-out; }
    dialog[open] { @starting-style { opacity: 0; scale: 0.95; } }
  }
  dialog::backdrop { background: rgb(2 6 24 / 0.5); backdrop-filter: blur(4px); }
</style></head><body>${'<p>A line of the page behind.</p>'.repeat(20)}
<dialog><h2>On board</h2>${'<p>Notes are sealed on your device before they leave it.</p>'.repeat(6)}</dialog>
</body></html>`;

/** The dialog's first shot once it has opened and stilled, in the visual projects' motion, then
 *  again after a theme round trip has repainted it: what their light and dark shots each see. */
const firstAndRepainted = async (browser: Browser): Promise<string> => {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: VISUAL_MOTION,
  });
  await page.setContent(DIALOG);
  await page.locator('dialog').evaluate((dialog: HTMLDialogElement) => {
    dialog.showModal();
  });
  await untilStill(page);
  const first = await saved('first.png', await viewportShot(page));
  await page.emulateMedia({ colorScheme: 'dark' });
  await untilStill(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await untilStill(page);
  const repainted = await saved('again.png', await viewportShot(page));
  return diffSummary(first, repainted);
};

await test('a dialog opened with motion reduced, as the visual projects open it, is drawn settled', async () => {
  const browser = await chromium.launch();
  try {
    assert.equal(await firstAndRepainted(browser), 'no pixel differs over the shared area');
  } finally {
    await browser.close();
  }
});

await test('a failed comparison names its pixels, a missing baseline, or the failure itself', () => {
  const unstable = new Error('Failed to take two consecutive stable screenshots.');
  const none = { expected: undefined, actual: undefined, previous: undefined };
  const alone = { expected: undefined, actual: 'a.png', previous: undefined };
  const restless = { expected: undefined, actual: 'a.png', previous: 'p.png' };
  assert.match(verdictOf(alone, unstable), /^no baseline to compare with/u);
  assert.equal(verdictOf(restless, unstable), 'Failed to take two consecutive stable screenshots.');
  assert.equal(verdictOf(none, new Error('the page closed')), 'the page closed');
});
