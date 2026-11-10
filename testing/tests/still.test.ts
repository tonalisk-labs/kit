// The rest wait in every engine: a dialog's entry from @starting-style is awaited until applied to
// style; a motion's end event, sent after its promise, is awaited too; an animation that fills
// forwards, or never ends, is not waited on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, firefox, webkit } from '@playwright/test';

import { inPage } from '../src/checks/in-page.ts';
import { STILL_KIT, still, untilStill } from '../src/checks/still.ts';

const PAGE = `<!doctype html><html><head><style>
dialog { inset-block: 0; inset-inline: auto 0; width: 300px; height: 100%; margin: 0 }
dialog[open] { transition: translate 150ms ease-out; @starting-style { translate: 100% 0 } }
@keyframes in { from { opacity: 0 } }
.filled { animation: in 10ms forwards }
@keyframes turn { to { rotate: 1turn } }
.spinner { animation: turn 1s linear infinite }
</style></head><body>
<button commandfor="d" command="show-modal">Open</button><p class="filled">a</p>
<p class="spinner">b</p><dialog id="d"><button commandfor="d" command="close">Close</button></dialog>
</body></html>`;

/** A fade and a pulse, each begun by the class `on`. */
const MOTIONS = `<!doctype html><html><head><style>
.fade { transition: opacity 100ms } .on .fade { opacity: 0.5 }
@keyframes pulse { to { scale: 1.1 } }
.on .pulse { animation: pulse 100ms }
</style></head><body><p class="fade">a</p><p class="pulse">b</p></body></html>`;

/** In the page: the end events sent by the time `still` returns, the motions begun just before. */
const toldByStill = async (): Promise<string[]> => {
  const told: string[] = [];
  for (const type of ['transitionend', 'animationend']) {
    globalThis.document.addEventListener(type, (event) => {
      told.push(event.type);
    });
  }
  globalThis.document.body.classList.add('on');
  await still();
  return told.toSorted();
};

await Promise.all(
  [chromium, firefox, webkit].map(async (engine) =>
    test(`${engine.name()}: still waits out a dialog's entry until it is drawn at its end, and each motion's end event`, async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        await page.setContent(PAGE);
        await untilStill(page);
        await page.getByRole('button', { name: 'Open' }).click();
        await untilStill(page);
        const translate = await page.evaluate(
          () =>
            globalThis.getComputedStyle(
              globalThis.document.querySelector('dialog') ?? globalThis.document.body,
            ).translate,
        );
        assert.equal(translate, 'none');
        await page.setContent(MOTIONS);
        assert.deepEqual(
          await inPage(page, STILL_KIT)(toldByStill),
          ['animationend', 'transitionend'],
          'each end event follows its promise, and still waits for it',
        );
      } finally {
        await browser.close();
      }
    }),
  ),
);
