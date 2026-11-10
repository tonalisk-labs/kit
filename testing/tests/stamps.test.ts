// The meter's DOM stamps date a step's outcome from the last change inside it, and keep no node the
// page let go, so a heap read beside the meter is the page's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, type Page } from '@playwright/test';

import { beginStamps, collectStamps, endStamps } from '../src/perf/stamps.ts';

const KEY = 'stamps.test';

/** A page with an empty list, its DOM changes stamped. */
const metered = async (page: Page): Promise<void> => {
  await page.setContent('<ul id="list"></ul>');
  await page.evaluate(collectStamps, { key: KEY });
};

/** Adds an item to the list and removes it once the page has seen it, held only weakly after. */
const addAndDrop = async (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const item = globalThis.document.createElement('li');
    item.textContent = 'let go';
    const list = globalThis.document.querySelector('#list');
    if (list !== null) {
      list.append(item);
    }
    await new Promise<void>((seen) => {
      globalThis.requestAnimationFrame(() => {
        seen();
      });
    });
    item.remove();
    Reflect.set(globalThis, 'dropped', new WeakRef(item));
  });

/** Whether the item last dropped outlived a full collection. */
const outlived = async (page: Page): Promise<boolean> => {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  await session.detach();
  return page.evaluate(() => {
    const dropped: unknown = Reflect.get(globalThis, 'dropped');
    return dropped instanceof WeakRef && dropped.deref() !== undefined;
  });
};

/** The page's next frame, which follows every change made before it. */
const nextFrame = async (page: Page): Promise<void> =>
  page.evaluate(
    async () =>
      new Promise<void>((painted) => {
        globalThis.requestAnimationFrame(() => {
          painted();
        });
      }),
  );

await test('a node the page lets go, before a step or after one, is the collector’s', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await metered(page);
    await addAndDrop(page);
    assert.equal(await outlived(page), false, 'before any step');
    const since = await page.evaluate(beginStamps, KEY);
    await addAndDrop(page);
    const list = await page.locator('#list').elementHandle();
    await page.evaluate(endStamps, [list, KEY, since] as const);
    assert.equal(await outlived(page), false, 'inside a step, once it ended');
    await addAndDrop(page);
    assert.equal(await outlived(page), false, 'after a step');
  } finally {
    await browser.close();
  }
});

await test('a step’s outcome dates from a frame the page painted after the change', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await metered(page);
    const since = await page.evaluate(beginStamps, KEY);
    await page.evaluate(() => {
      const frames: number[] = [];
      Reflect.set(globalThis, 'frames', frames);
      const item = globalThis.document.createElement('li');
      item.id = 'outcome';
      const list = globalThis.document.querySelector('#list');
      if (list !== null) {
        list.append(item);
      }
      const tick = (frame: number): void => {
        frames.push(frame);
        globalThis.requestAnimationFrame(tick);
      };
      globalThis.requestAnimationFrame(tick);
    });
    await nextFrame(page);
    await nextFrame(page);
    const outcome = await page.locator('#outcome').elementHandle();
    const seen = await page.evaluate(endStamps, [outcome, KEY, since] as const);
    const frames = await page.evaluate((): unknown => Reflect.get(globalThis, 'frames'));
    assert.equal(seen.navigated, false);
    assert.equal(seen.from, since);
    assert.ok(
      Array.isArray(frames) && frames.includes(seen.visibleAt),
      `${String(seen.visibleAt)} is a frame painted after the change`,
    );
  } finally {
    await browser.close();
  }
});
