// The layout rules' helpers on fixed pages in a real browser: the same names, boxes and findings
// as reading each element's whole text and walking every ancestor per box, at a fraction of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium, type Page } from '@playwright/test';

import { geometryOf, layoutFindings, parity } from '../src/checks/layout.ts';

const nested = (depth: number, inner: string): string =>
  depth === 0
    ? inner
    : `<div style="overflow:${depth % 3 === 0 ? 'auto' : 'visible'};width:${String(700 - depth * 10)}px;margin:1px;padding:1px">${nested(depth - 1, inner)}</div>`;

const buttons = (count: number): string =>
  Array.from(
    { length: count },
    (_button, at) =>
      `<button style="width:44px;height:44px;margin:0 0 0 -10px">b ${String(at)}  <i> in </i></button>`,
  ).join('');

const pageOf = (
  depth: number,
  count: number,
): string => `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<p>   lots   of
  whitespace\n\n here and a very long sentence that keeps on going past forty characters </p>
<div style="overflow:hidden;width:50px;white-space:nowrap">cut off text that is too long</div>
<div style="overflow:hidden;width:50px;white-space:nowrap;text-overflow:ellipsis">ellipsis text that is long</div>
<div style="overflow:hidden;height:10px">tall<br>tall<br>tall</div>
<div style="overflow:hidden;width:50px;white-space:nowrap"></div>
<span>   </span><b>  x  </b><button aria-label="labelled">  </button>
${nested(depth, buttons(count))}
</body></html>`;

/** The reference names: each element's whole text, folded, then cut. */
const WHOLE_TEXT_NAMES = `[document.body, ...document.body.querySelectorAll('*')].map((element) => {
  const text = element.textContent.trim().replaceAll(/\\s+/gu, ' ').slice(0, 40);
  return '<' + element.localName + '> "' + (text === '' ? (element.getAttribute('aria-label') ?? '') : text) + '"';
})`;

const COUNT_STYLES = `(() => {
  const counts = { styles: 0 };
  Reflect.set(globalThis, 'counts', counts);
  const style = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (...args) => {
    counts.styles += 1;
    return style(...args);
  };
})()`;

const names = async (page: Page): Promise<void> => {
  await page.setContent(pageOf(12, 40));
  const geometry = Object.keys(await geometryOf(page)).map((key) =>
    key.split(' ').slice(1).join(' '),
  );
  const whole = await page.evaluate<string[]>(WHOLE_TEXT_NAMES);
  assert.ok(geometry.length > 100);
  assert.ok(geometry.every((name) => whole.includes(name)));
  assert.ok(geometry.includes('<p> "lots of whitespace here and a very long "'));
  assert.ok(geometry.includes('<button> "labelled"'));
};

const findings = async (page: Page): Promise<void> => {
  await page.setContent(pageOf(12, 40));
  const found = await layoutFindings(page, { touch: true, toasts: undefined });
  assert.deepEqual(found.clipped, [
    '<div> "cut off text that is too long" cuts off its content',
    '<div> "talltalltall" cuts off its content',
  ]);
  assert.equal(found.overlap.length, 32);
  assert.deepEqual(found.overlap.slice(0, 2), [
    '<button> "b 0 in" overlaps <button> "b 1 in"',
    '<button> "b 1 in" overlaps <button> "b 2 in"',
  ]);
};

const styleReads = async (page: Page): Promise<void> => {
  await page.setContent(pageOf(40, 200));
  await page.evaluate(COUNT_STYLES);
  await layoutFindings(page, { touch: false, toasts: undefined });
  const { styles } = await page.evaluate<{ styles: number }>('globalThis.counts');
  // Every element's own read and each ancestor once; per box and ancestor would be over 8,000.
  assert.ok(styles < 1000, `${String(styles)} style reads`);
};

/** A page taller than its window, a bar fixed to the window's foot and a box in the flow. */
const SCROLLED = `<!doctype html><html><body style="margin:0;height:3000px">
<div style="height:40px;width:200px;margin-top:500px">in the flow</div>
<section style="position:fixed;bottom:20px;left:0;width:300px;height:30px"><b>fixed</b></section>
</body></html>`;

const scrolled = async (page: Page): Promise<void> => {
  await page.setContent(SCROLLED);
  await page.evaluate(() => {
    globalThis.scrollTo(0, 700);
  });
  const before = await geometryOf(page);
  await page.evaluate(() => {
    globalThis.scrollTo(0, 701);
  });
  const after = await geometryOf(page);
  assert.deepEqual(parity(before, after, ['before', 'after']), []);
  const fixed = Object.entries(after)
    .filter(([key]) => key.includes('<section>'))
    .map(([, box]) => box);
  assert.deepEqual(fixed, [`0.0, ${String(1200 - 20 - 30)}.0, 300.0, 30.0`]);
};

await test('the layout helpers in a browser', async (context) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
    await context.test('an element is named by the first 40 characters of its text', async () =>
      names(page),
    );
    await context.test('clipping finds the cut-off boxes, overlap the stacked buttons', async () =>
      findings(page),
    );
    await context.test('each clipping ancestor is read once per measure', async () =>
      styleReads(page),
    );
    await context.test('a scroll moves no box, in the flow or fixed to the window', async () =>
      scrolled(page),
    );
  } finally {
    await browser.close();
  }
});
