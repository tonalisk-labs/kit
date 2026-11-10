// The design and layout rules on fixed pages in a real browser: each finding they make, and the
// reads they spend, so a rule stays linear in the page rather than in pairs of its parts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { chromium, type Page } from '@playwright/test';

import { axeFindings, MORE_CONTRAST, MORE_CONTRAST_BAR } from '../src/checks/axe.ts';
import { designFindings } from '../src/checks/design.ts';
import { layoutFindings } from '../src/checks/layout.ts';

const SCALE = {
  text: [0.875, 1],
  colours: ['#ffffff', '#000000', '#1e293b', 'transparent'],
  themes: { brand: ['#ef4444'] },
};

/** One of each finding the design rules make, and the near misses they must pass. */
const DESIGN_PAGE = `<!doctype html><html><body style="margin:8px;font:16px sans-serif;color:#1e293b;background:#fff">
<p>Plain <span>words</span> <b>spaced</b></p>
<p><span>glued</span><span>together</span> and <em>fine</em>, <i>also</i></p>
<p style="color:#ef4444">off palette ink</p>
<section data-palette="brand"><p style="color:#ef4444">brand ink</p></section>
<p style="font-size:13px">odd size</p>
<p style="color:#ffffff;background:#ffffff">faint</p>
<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">hidden<b>label</b></span>
<div style="overflow:hidden;width:60px;white-space:nowrap"><span>clipped</span><span>away</span></div>
<p style="background-image:linear-gradient(#000,#fff);color:#fff">over an image</p>
</body></html>`;

/** A site's own web font, as the checks ask of one (preloaded, displayed optional, with a local
 *  fallback sized to it, its stack in --font-body), beside a stray web font that does neither. */
const FONT_PAGE = `<!doctype html><html><head>
<link rel="preload" href="https://fonts.test/own.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:"Own Face";src:url("https://fonts.test/own.woff2") format("woff2");font-display:optional}
@font-face{font-family:"Own Face fallback: Times New Roman";src:local("Times New Roman");font-display:swap;size-adjust:110%}
@font-face{font-family:"Stray";src:url("https://fonts.test/stray.woff2") format("woff2");font-display:swap}
:root{--font-body:"Own Face","Own Face fallback: Times New Roman",serif}
body{font-family:var(--font-body)}
.stray{font-family:"Stray",sans-serif}
</style></head><body style="margin:8px;font-size:16px;color:#1e293b;background:#fff">
<p>In the site's own font</p><p class="stray">In a stray one</p></body></html>`;

/** 300 rows of nested text over alternating backgrounds, in two colours. */
const LONG_PAGE = `<!doctype html><html><body style="margin:8px;font:16px sans-serif;color:#1e293b;background:#fff">${Array.from(
  { length: 300 },
  (_row, at) =>
    `<div style="background:${at % 2 === 0 ? 'transparent' : '#fff'}"><ul><li><p><span>word ${String(at)}</span><b>x</b> <em>y</em></p></li></ul></div>`,
).join('')}</body></html>`;

const button = (row: number, column: number): string =>
  `<button style="position:absolute;left:${String(column * 50)}px;top:${String(row * 50)}px;width:44px;height:44px">b${String(row)}-${String(column)}</button>`;

/** 200 controls on a grid, one laid over three of them, and one inside another. */
const GRID_PAGE = `<!doctype html><html><body style="margin:0">
${Array.from({ length: 200 }, (_cell, at) => button(Math.floor(at / 10), at % 10)).join('')}
<button style="position:absolute;left:20px;top:20px;width:44px;height:44px">over</button>
<a href="#" style="position:absolute;left:600px;top:0;display:block;width:100px;height:44px">outer <span role="button" style="display:inline-block;width:44px;height:44px">inner</span></a>
</body></html>`;

/** Each way a control's boundary is drawn (WCAG 1.4.11): by its own border or underline, by its
 *  own frame, by the label an unpainted radio lies over, by the platform; and each falling short. */
const BOUNDARY_PAGE = `<!doctype html><html><body style="margin:8px;font:16px sans-serif;color:#1e293b;background:#fff">
<style>.flat{border:0;background:transparent}.over{position:absolute;inset:0;margin:0;appearance:none}
.track{display:inline-flex;gap:4px;padding:4px;background:#f1f5f9}.option{position:relative;padding:4px 12px}</style>
<p><input aria-label="faint" style="border:1px solid #eeeeee;background:#fff"></p>
<p><input aria-label="edged" style="border:1px solid #64748b;background:#fff"></p>
<p><input aria-label="underlined" class="flat" style="border-bottom:2px solid #64748b"></p>
<div style="display:flex;border:1px solid #64748b"><span>@</span><input aria-label="framed" class="flat"><button>Change</button></div>
<div style="display:flex;border:1px solid #eeeeee"><input aria-label="faintly framed" class="flat"></div>
<fieldset style="border:1px solid #64748b"><input aria-label="grouped one" class="flat"><input aria-label="grouped two" class="flat"></fieldset>
<p><label><input type="checkbox"> native</label> <label><input type="checkbox" checked style="accent-color:#2563eb"> own accent</label>
<label><input type="checkbox" aria-label="pale accent" checked style="accent-color:#eeeeee"> pale</label></p>
<div class="track"><label class="option"><input type="radio" name="seg" class="over">Off</label><label class="option" style="background:#2563eb;color:#fff"><input type="radio" name="seg" class="over" checked>On</label></div>
<div class="track"><label class="option"><input type="radio" name="flat" class="over" checked>Unmarked</label><label class="option"><input type="radio" name="flat" class="over">Other</label></div>
<label class="option" title="One star"><input type="radio" name="star" class="over" aria-label="One star" checked><svg width="16" height="16"><path d="M0 0h16v16H0z" fill="#f59e0b"/></svg></label>
</body></html>`;

/** What axe-core holds a page to: contrast at AA, every control named, every role real. The
 *  first grey is 4.54:1 on white, short of AAA's 7:1 alone; the second 3.03:1. */
const AXE_PAGE = `<!doctype html><html lang="en"><head><title>Axe</title></head><body>
<main><h1>Axe</h1><p style="color:#767676">grey ink</p><p style="color:#949494">pale ink</p>
<button></button><div role="nonsense">x</div></main>
</body></html>`;

/** Counts canvas readbacks and style reads from here on. */
const COUNTING = `(() => {
  const counts = { readbacks: 0, styles: 0 };
  Reflect.set(globalThis, 'counts', counts);
  const read = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    counts.readbacks += 1;
    return read.apply(this, args);
  };
  const style = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (...args) => {
    counts.styles += 1;
    return style(...args);
  };
})()`;

const counted = async (page: Page): Promise<{ readbacks: number; styles: number }> =>
  page.evaluate<{ readbacks: number; styles: number }>('globalThis.counts');

const designRules = async (page: Page): Promise<void> => {
  await page.setContent(DESIGN_PAGE);
  assert.deepEqual(await designFindings(page, SCALE), {
    typography: ['<p> "odd size" is 13.00px, off the text scale'],
    palette: ['<p> "off palette ink" text #ef4444 is off the palette'],
    glued: [
      '"glued" runs into "together" (0.0px apart)',
      '"clipped" runs into "away" (0.0px apart)',
    ],
    fonts: [],
    flash: [],
    reported: [],
  });
};

const boundaries = async (page: Page): Promise<void> => {
  await page.setContent(BOUNDARY_PAGE);
  const { reported } = await designFindings(page, SCALE);
  assert.deepEqual(reported, [
    '<input> "faint" boundary 1.16:1 < 3:1 (not held)',
    '<input> "faintly framed" boundary 1.16:1 < 3:1 (not held)',
    '<input> "grouped one" boundary 1.00:1 < 3:1 (not held)',
    '<input> "grouped two" boundary 1.00:1 < 3:1 (not held)',
    '<input> "pale accent" accent 1.16:1 < 3:1 (not held)',
    '<label> "Unmarked" boundary 1.00:1 < 3:1 (not held)',
  ]);
};

const fontRules = async (page: Page): Promise<void> => {
  await page.setContent(FONT_PAGE);
  const { fonts, flash } = await designFindings(page, SCALE);
  assert.deepEqual(fonts, [
    `the web font "Stray" is on the page, and not the site's own`,
    `the font "Stray" is set on text, not a system stack or the site's own`,
  ]);
  assert.deepEqual(flash, [
    'the web font "Stray" is displayed swap, not optional',
    'the web font "Stray" (https://fonts.test/stray.woff2) is not preloaded',
  ]);
};

const readbacks = async (page: Page): Promise<void> => {
  await page.setContent(LONG_PAGE);
  await page.evaluate(COUNTING);
  await designFindings(page, SCALE);
  const { readbacks: spent } = await counted(page);
  // A handful per colour and rule: each colour is read back once.
  assert.ok(spent < 1000, `${String(spent)} readbacks`);
};

const axeRules = async (page: Page, paused: boolean): Promise<void> => {
  await page.setContent(AXE_PAGE);
  if (paused) {
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 60_000);
  }
  const found = await axeFindings(page);
  const rules = new Set(found.map((finding) => finding.split(' ')[0] ?? ''));
  assert.deepEqual(
    [...rules].toSorted((one, other) => one.localeCompare(other)),
    ['aria-roles', 'button-name', 'color-contrast'],
  );
  // The pale ink alone: the grey ink clears AA.
  assert.equal(
    found.filter((finding) => finding.startsWith('color-contrast')).length,
    1,
    found.join('\n'),
  );
};

const overlaps = async (page: Page): Promise<void> => {
  await page.setContent(GRID_PAGE);
  await page.evaluate(COUNTING);
  const { overlap } = await layoutFindings(page, { touch: false, toasts: undefined });
  assert.deepEqual(overlap, [
    '<button> "b0-1" overlaps <button> "over"',
    '<button> "b1-0" overlaps <button> "over"',
    '<button> "b1-1" overlaps <button> "over"',
  ]);
  const { styles } = await counted(page);
  // The other layout rules read about 400; measuring every pair's boxes would read 81,603.
  assert.ok(styles < 2000, `${String(styles)} style reads`);
};

/** A field of one of axe-core's records. */
const field = (value: unknown, key: string): unknown => {
  assert.ok(typeof value === 'object' && value !== null, `no ${key}`);
  return Reflect.get(value, key);
};

/** A record's fields but one, by name. */
const besides = (value: unknown, key: string): [string, unknown][] => {
  assert.ok(typeof value === 'object' && value !== null, 'no options');
  return Object.entries(value)
    .filter(([name]) => name !== key)
    .toSorted(([one], [other]) => one.localeCompare(other));
};

await test("more contrast runs axe-core's own enhanced-contrast options, but Apple's bar", () => {
  // The options live in axe-core's audit alone, so one it adds there fails this.
  const axe: unknown = createRequire(import.meta.url)('axe-core');
  const checks = field(field(axe, '_audit'), 'checks');
  const own = field(field(checks, 'color-contrast-enhanced'), 'options');
  const given = field(field(MORE_CONTRAST.checks, 'color-contrast-enhanced'), 'options');
  assert.deepEqual(besides(given, 'contrastRatio'), besides(own, 'contrastRatio'));
  assert.deepEqual(field(given, 'contrastRatio'), {
    normal: { expected: MORE_CONTRAST_BAR, minThreshold: 4.5 },
    large: { expected: 4.5, minThreshold: 3 },
  });
});

await test('axe-core answers under a paused page clock', async () => {
  const browser = await chromium.launch();
  try {
    await axeRules(await browser.newPage(), true);
  } finally {
    await browser.close();
  }
});

await test('the page rules in a browser', async (context) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 1200 } });
    await context.test(
      'the design rules report each fault once, and pass what is on the scale',
      async () => designRules(page),
    );
    await context.test(
      "a control's boundary is its own, its frame's, its chosen label's or the platform's",
      async () => boundaries(page),
    );
    await context.test(
      "a site's own font passes, preloaded and optional; a stray one is caught twice over",
      async () => fontRules(page),
    );
    await context.test('colours are read back once each, not per element and ancestor', async () =>
      readbacks(page),
    );
    await context.test(
      'axe-core finds contrast below AA, not AAA, an unnamed control, a false role',
      async () => axeRules(page, false),
    );
    await context.test(
      'overlap pairs only controls whose rows meet, each measured once',
      async () => overlaps(page),
    );
  } finally {
    await browser.close();
  }
});
