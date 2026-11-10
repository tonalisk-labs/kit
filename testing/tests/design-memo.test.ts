// One text-owner walk per call and each ink colour read back once, with every finding still made.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, type Page } from '@playwright/test';

import { designFindings } from '../src/checks/design.ts';

const SCALE = { text: [1], colours: ['#ffffff', '#000000', '#1e293b', 'transparent'] };

/** 200 text owners sharing 30 translucent wrappers, all in one ink. */
const DEEP_PAGE = `<!doctype html><html><body style="margin:8px;font:16px sans-serif;color:#1e293b;background:#fff">${'<div style="opacity:0.99">'.repeat(30)}${Array.from(
  { length: 200 },
  (_row, at) => `<p>row ${String(at)}</p>`,
).join('')}${'</div>'.repeat(30)}<p style="opacity:0.2">faded</p></body></html>`;

/** Counts text walkers and canvas readbacks from here on. */
const COUNTING = `(() => {
  const counts = { walkers: 0, readbacks: 0 };
  Reflect.set(globalThis, 'counts', counts);
  const walker = Document.prototype.createTreeWalker;
  Document.prototype.createTreeWalker = function (root, show, ...rest) {
    if (root === document.body && show === NodeFilter.SHOW_TEXT) counts.walkers += 1;
    return walker.call(this, root, show, ...rest);
  };
  const read = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    counts.readbacks += 1;
    return read.apply(this, args);
  };
})()`;

interface Counts {
  walkers: number;
  readbacks: number;
}

const deep = async (page: Page): Promise<void> => {
  await page.setContent(DEEP_PAGE);
  await page.evaluate(COUNTING);
  const found = await designFindings(page, SCALE);
  assert.deepEqual(found.typography, []);
  assert.deepEqual(found.palette, []);
  const counts = await page.evaluate<Counts>('globalThis.counts');
  assert.equal(counts.walkers, 1, 'one text-owner walk for the whole call');
  assert.ok(counts.readbacks < 40, `${String(counts.readbacks)} readbacks`);
};

const fresh = async (page: Page): Promise<void> => {
  await page.setContent(
    '<!doctype html><html><body><p style="font-size:13px">new</p></body></html>',
  );
  const found = await designFindings(page, SCALE);
  assert.deepEqual(found.typography, ['<p> "new" is 13.00px, off the text scale']);
};

await test('the design rules share their reads within a call', async (context) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
    await context.test('deep translucent text is judged with each read made once', async () =>
      deep(page),
    );
    await context.test('a later call walks the new page, not the last call’s owners', async () =>
      fresh(page),
    );
  } finally {
    await browser.close();
  }
});
