import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type BrowserType, chromium, firefox, type Page, webkit } from '@playwright/test';

import { invisibleFocusables, type Reach, tabThrough } from '../src/checks/focus.ts';

const buttons = (count: number): string =>
  Array.from({ length: count }, (_button, at) => `<button>b${String(at)}</button>`).join('');

const FEW = `<header><a href="#">home</a></header><main>${buttons(5)}</main>`;
const MANY = `<header><a href="#">h</a></header><main>${buttons(30)}</main><footer><a href="#">f</a></footer>`;
const TRAP = `<main><button>a</button><input id="trap"><button>after</button></main>
<script>
  document.getElementById('trap').addEventListener('keydown', (event) => {
    if (event.key === 'Tab') event.preventDefault();
  });
</script>`;
const AFTER = '<button> "after" is not reached by Tab';

interface Case {
  readonly html: string;
  readonly minimum: number;
  readonly reach: Reach;
}

/** Each page and minimum, and the walk every engine takes, as read after each press. */
const CASES: readonly Case[] = [
  { html: FEW, minimum: 0, reach: { presses: 6, unreached: [] } },
  { html: FEW, minimum: 20, reach: { presses: 20, unreached: [] } },
  { html: MANY, minimum: 20, reach: { presses: 31, unreached: [] } },
  { html: TRAP, minimum: 0, reach: { presses: 10, unreached: [AFTER] } },
  { html: TRAP, minimum: 20, reach: { presses: 20, unreached: [AFTER] } },
  {
    html: '<div><button>x</button></div>',
    minimum: 20,
    reach: { presses: 0, unreached: ['the page has no <main> landmark'] },
  },
];

const walks = async (page: Page, key: string, cases: readonly Case[]): Promise<Reach[]> => {
  const [first, ...rest] = cases;
  if (first === undefined) {
    return [];
  }
  await page.setContent(first.html);
  const reach = await tabThrough(page, key, first.minimum);
  return [reach, ...(await walks(page, key, rest))];
};

const ENGINES: readonly (readonly [string, BrowserType, string])[] = [
  ['chromium', chromium, 'Tab'],
  ['firefox', firefox, 'Tab'],
  ['webkit', webkit, 'Alt+Tab'],
];

await Promise.all(
  ENGINES.map(async ([name, engine, key]) =>
    test(`${name}: the Tab walk on each page reaches what its case says`, async () => {
      const browser = await engine.launch();
      try {
        const page = await browser.newPage();
        assert.deepEqual(
          await walks(page, key, CASES),
          CASES.map(({ reach }) => reach),
        );
      } finally {
        await browser.close();
      }
    }),
  ),
);

await test('a control that takes focus unseen is named, a frame by where it came from, bar those exempt', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://frames.test/**', async (route) => route.fulfill({ body: '' }));
    await page.setContent(`<main>
      <button>seen</button>
      <button style="opacity: 0">faded</button>
      <button aria-label="Close" style="position: fixed; left: -100px"></button>
      <iframe title="Card" src="https://frames.test/inner/card.html?key=k#at" style="border: 0; height: 0"></iframe>
      <iframe src="about:blank" style="border: 0; width: 1px; height: 1px"></iframe>
    </main>`);
    assert.deepEqual(await invisibleFocusables(page), [
      '<button> "faded" takes focus but cannot be seen',
      '<button> "Close" takes focus but cannot be seen',
      '<iframe> "Card" from https://frames.test/inner/card.html takes focus but cannot be seen',
      '<iframe> "" takes focus but cannot be seen',
    ]);
    assert.deepEqual(
      await invisibleFocusables(page, 'iframe[src^="https://frames.test/"], [aria-label]'),
      [
        '<button> "faded" takes focus but cannot be seen',
        '<iframe> "" takes focus but cannot be seen',
      ],
    );
  } finally {
    await browser.close();
  }
});
