// The sweep's modes on fixed pages in a real browser: what still moves under reduced motion, a
// focus ring forced colours drop, text short of Apple's bar with more contrast in each theme, text
// cut off once spaced out, a phone's page at 320 px, and each mode taken back after.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Browser, chromium, type Page } from '@playwright/test';

import { inEveryMode, motionFindings, type Viewed } from '../src/checks/modes.ts';
import { type Row, ROWS } from '../src/matrix.ts';

const rowOf = (form: Row['form']): Row => {
  const row = ROWS.find((one) => one.form === form && one.engine === 'chromium');
  assert.ok(row !== undefined, `a Chromium ${form} row`);
  return row;
};

/** Every rule the modes hold the page at `html` to, viewed as given, with what each found. */
const judged = async (viewed: Viewed, html: string): Promise<Map<string, readonly string[]>> => {
  await viewed.page.setContent(html);
  const found = new Map<string, readonly string[]>();
  await inEveryMode(viewed, (findings, rule) => {
    found.set(rule, findings);
  });
  return found;
};

const modesOf = async (
  page: Page,
  html: string,
  row: Row,
): Promise<Map<string, readonly string[]>> => judged({ page, row, toasts: undefined }, html);

const MORE = "text at 5.3:1 with more contrast, as Apple's";

const matches = async (page: Page, query: string): Promise<boolean> =>
  page.evaluate((media) => globalThis.matchMedia(media).matches, query);

const failing = (found: ReadonlyMap<string, readonly string[]>): string[] =>
  [...found].flatMap(([rule, findings]) => findings.map((finding) => `${rule}: ${finding}`));

const QUIET = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  button { width: 10rem; height: 3rem; }
  button:focus-visible { outline: 2px solid rgb(37 99 235); outline-offset: 2px; }
  @media (prefers-reduced-motion: no-preference) { .drawer { transition: transform .3s; } }
  .fade { transition: color .2s, background-color .2s, transform .2s; }
</style></head><body><main><h1>Fine</h1><p class="drawer">A drawer that slides only when motion is welcome.</p>
<button type="button" class="fade">Fades its colour</button></main></body></html>`;

const motion = async (page: Page): Promise<void> => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(QUIET);
  assert.deepEqual(await motionFindings(page), []);
  await page.setContent(`<!doctype html><html><head><style>
    html { scroll-behavior: smooth; }
    .slide { transition: transform .3s, translate .3s; }
    .every { transition: all .2s; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { rotate: 1turn; } }
  </style></head><body><p class="slide">slides</p><p class="every">changes</p>
  <p class="spin">spins</p></body></html>`);
  const found = await motionFindings(page);
  assert.ok(
    found.includes('<p> "slides" moves its transform, translate as it changes'),
    found.join('\n'),
  );
  assert.ok(found.includes('<p> "changes" moves its all as it changes'), found.join('\n'));
  assert.ok(found.includes('<p> "spins" runs an animation of its rotate'), found.join('\n'));
  assert.ok(found.includes('<html> scrolls smoothly'), found.join('\n'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
};

const quietPage = async (page: Page): Promise<void> => {
  const found = await modesOf(page, QUIET, rowOf('desktop'));
  assert.deepEqual(failing(found), []);
  assert.ok(found.has('nothing moves under reduced motion (WCAG 2.3.3)'));
  assert.ok(found.has('focus rings at 3:1 with colours forced'));
  assert.ok(found.has(MORE));
  assert.ok(found.has('no content cut off with text spaced out (WCAG 1.4.12)'));
  // Each mode is taken back: no media emulated, and none of the modes' sheets left adopted.
  assert.equal(
    await page.evaluate(() => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches),
    false,
  );
  assert.equal(
    await page.evaluate(() => globalThis.matchMedia('(forced-colors: active)').matches),
    false,
  );
  assert.equal(await matches(page, '(prefers-contrast: more)'), false);
  assert.equal(await page.evaluate(() => globalThis.document.adoptedStyleSheets.length), 0);
};

// #767676 is 4.54:1 on white: AA's, short of Apple's 5.3:1. With more contrast, the second line
// takes iOS's own secondary label on its grouped background, at 5.33:1.
const GREY = `<!doctype html><html lang="en"><head><title>Grey</title><style>
  body { margin: 2rem; font: 16px sans-serif; background: #fff; color: #767676; }
  .deeper { background: #ebebf0; color: #666666; @media (prefers-contrast: more) { color: rgb(60 60 67 / 0.8); } }
</style></head><body><main><p>Grey ink</p><p class="deeper">Grey ink, deeper on request</p></main></body></html>`;

const greyText = async (page: Page): Promise<void> => {
  const found = await modesOf(page, GREY, rowOf('desktop'));
  const short = found.get(MORE) ?? [];
  assert.equal(short.length, 1, short.join('\n'));
  assert.match(short[0] ?? '', /^color-contrast-enhanced p:nth-child\(1\): .*4\.54/u);
  assert.equal(await matches(page, '(prefers-contrast: more)'), false);
};

// Fine in light; in dark, #777777 on black is 4.68:1 and nothing deepens it.
const THEMED = `<!doctype html><html lang="en"><head><title>Themed</title><style>
  :root { color-scheme: light; }
  body { margin: 2rem; font: 16px sans-serif; background: #fff; color: #555555; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; }
    body { background: #000; color: #777777; }
  }
</style></head><body><main><p>Ink in either theme</p></main></body></html>`;

const eachTheme = async (page: Page): Promise<void> => {
  await page.emulateMedia({ colorScheme: 'light' });
  const viewed = {
    page,
    row: rowOf('desktop'),
    toasts: undefined,
    themes: ['light', 'dark'] as const,
  };
  const found = await judged(viewed, THEMED);
  assert.deepEqual(found.get(`${MORE} (light)`), []);
  const dark = found.get(`${MORE} (dark)`) ?? [];
  assert.equal(dark.length, 1, dark.join('\n'));
  assert.match(dark[0] ?? '', /^color-contrast-enhanced p: .*4\.68/u);
  assert.equal(found.has(MORE), false);
  // The theme the system had is put back.
  assert.equal(await matches(page, '(prefers-color-scheme: dark)'), false);
};

const shadowRing = async (page: Page): Promise<void> => {
  const found = await modesOf(
    page,
    `<!doctype html><html><head><style>
      body { margin: 2rem; font: 16px sans-serif; background: white; }
      button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(37 99 235); }
    </style></head><body><main><button type="button">A shadow for a ring</button></main></body></html>`,
    rowOf('desktop'),
  );
  assert.deepEqual(found.get('focus rings at 3:1 with colours forced'), [
    '<button> "A shadow for a ring" shows no focus ring',
  ]);
};

const tightBox = async (page: Page): Promise<void> => {
  const found = await modesOf(
    page,
    `<!doctype html><html><head><style>body { margin: 0; font: 16px/1.2 sans-serif; }</style></head>
    <body><main><div style="width: 20rem; height: 1.25rem; overflow: hidden">Two words</div></main></body></html>`,
    rowOf('desktop'),
  );
  assert.deepEqual(found.get('no content cut off with text spaced out (WCAG 1.4.12)'), [
    '<div> "Two words" cuts off its content',
  ]);
};

const narrow = async (browser: Browser): Promise<void> => {
  const phone = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true });
  try {
    const found = await modesOf(
      phone,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width">
      <style>body { margin: 0; font: 16px sans-serif; } .wide { width: 360px; }</style></head>
      <body><main><p class="wide">A fixed width that fits a phone but not 320 px.</p></main></body></html>`,
      rowOf('phone'),
    );
    const rule = 'nothing scrolls sideways 320 px wide (WCAG 1.4.10)';
    assert.deepEqual(found.get(rule), ['the page scrolls sideways by 40px']);
    assert.deepEqual(found.get('the same layout once back from 320 px'), []);
    assert.deepEqual(phone.viewportSize(), { width: 390, height: 700 });
  } finally {
    await phone.close();
  }
};

await test('the sweep’s modes in a browser', async (context) => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await context.test('reduced motion finds what still moves, and no colour fade', async () =>
      motion(page),
    );
    await context.test('a quiet page holds every mode, each taken back', async () =>
      quietPage(page),
    );
    await context.test('with colours forced, a box-shadow ring is no ring', async () =>
      shadowRing(page),
    );
    await context.test(
      "with more contrast, text short of Apple's bar is found, and Apple's own passes",
      async () => greyText(page),
    );
    await context.test(
      'with more contrast, each theme the screen follows is judged, and the system’s put back',
      async () => eachTheme(page),
    );
    await context.test('spaced-out text overflows a box sized to the line', async () =>
      tightBox(page),
    );
    await context.test(
      'a phone’s page is held at 320 px, and laid out as before once back',
      async () => narrow(browser),
    );
  } finally {
    await browser.close();
  }
});
