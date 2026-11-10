// Keyboard-only tests on fixed pages in a real browser: the pointer watch hears a click and a
// wheel turn and no key or script, and focusReturns holds a dialog that gives focus back to its
// opener, and fails one that drops it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, type Page } from '@playwright/test';

import { focusReturns, pointerWatchScript } from '../src/keyboard.ts';

/** Where the watched page is served, by a route: nothing leaves the browser. */
const FIXTURE = 'https://keyboard.test/';

/** A page with a button that opens a modal dialog, and one whose dialog sends focus elsewhere
 *  as it closes. */
const PAGE = `<!doctype html><html><body style="font:16px sans-serif">
<main><button type="button" id="open">Settings</button>
<button type="button" id="lose">Settings, forgetful</button>
<button type="button" id="elsewhere">Elsewhere</button>
<dialog id="settings" aria-labelledby="t"><h2 id="t">Settings</h2><button type="button">Close</button></dialog>
<dialog id="forgetful" aria-labelledby="f"><h2 id="f">Forgetful</h2><button type="button">Close</button></dialog></main>
<script>
  const [settings, forgetful] = [document.querySelector('#settings'), document.querySelector('#forgetful')];
  document.querySelector('#open').addEventListener('click', () => settings.showModal());
  document.querySelector('#lose').addEventListener('click', () => forgetful.showModal());
  for (const dialog of [settings, forgetful]) {
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
  }
  forgetful.addEventListener('close', () => document.querySelector('#elsewhere').focus());
</script></body></html>`;

/** What a page's pointer watch heard, and a wait for it to have heard `count`: the page's
 *  main thread takes a wheel turn after Playwright's call returns. */
interface Watched {
  readonly heard: readonly string[];
  readonly reaching: (count: number) => Promise<void>;
}

const served = async (page: Page): Promise<Watched> => {
  const heard: string[] = [];
  const waiters: { readonly count: number; readonly done: () => void }[] = [];
  const binding = `heard${String(Math.random()).slice(2)}`;
  await page.exposeFunction(binding, (finding: string) => {
    heard.push(finding);
    for (const waiter of waiters.filter(({ count }) => heard.length >= count)) {
      waiter.done();
    }
  });
  await page.addInitScript({ content: pointerWatchScript(binding) });
  await page.route(FIXTURE, async (route) =>
    route.fulfill({ body: PAGE, contentType: 'text/html' }),
  );
  await page.goto(FIXTURE);
  const reaching = async (count: number): Promise<void> => {
    if (heard.length < count) {
      const { promise, resolve } = Promise.withResolvers<number>();
      waiters.push({
        count,
        done: () => {
          resolve(heard.length);
        },
      });
      await promise;
    }
  };
  return { heard, reaching };
};

const pointer = async (page: Page): Promise<void> => {
  const { heard, reaching } = await served(page);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  // A script's own pointer event is the page's doing, not a person's.
  await page.evaluate(() => {
    globalThis.document.body.dispatchEvent(new globalThis.PointerEvent('pointerdown'));
  });
  await page.locator('#elsewhere').click();
  await reaching(1);
  await page.mouse.wheel(0, 100);
  await reaching(2);
  // The page hears in order: a key or the script's event, had it been heard, would come first.
  assert.deepEqual(heard, ['pointerdown on <button>', 'wheel on <button>']);
};

const returns = async (page: Page): Promise<void> => {
  await served(page);
  await page.locator('#open').focus();
  await focusReturns(page, {
    open: async () => page.keyboard.press('Enter'),
    overlay: page.locator('#settings'),
    close: async () => page.keyboard.press('Escape'),
  });
  await page.locator('#lose').focus();
  await assert.rejects(
    focusReturns(page, {
      open: async () => page.keyboard.press('Enter'),
      overlay: page.locator('#forgetful'),
      close: async () => page.keyboard.press('Escape'),
    }),
    /focus comes back to the control that opened the overlay/u,
  );
};

await test('keyboard-only tests in a browser', async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test(
      'the pointer watch hears a pointer and a wheel, and no key or script',
      async () => pointer(await browser.newPage()),
    );
    await context.test(
      'focus is held to go into an overlay and come back to its opener',
      async () => returns(await browser.newPage()),
    );
  } finally {
    await browser.close();
  }
});
