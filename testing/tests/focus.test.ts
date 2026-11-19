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

/** A page whose script `act` runs once, the moment the page is first found still: when its
 *  document.getAnimations() first lists nothing, as still()'s last look does. */
const afterStill = (body: string, act: string): string => `<main>${body}</main>
<script>
  const listed = document.getAnimations.bind(document);
  let acted = false;
  document.getAnimations = () => {
    const found = listed();
    if (found.length === 0 && !acted) {
      acted = true;
      setTimeout(() => {
        ${act}
      });
    }
    return found;
  };
</script>`;

/** An offer that opens late, as one under load does, and fades in after 3 s at opacity 0. */
const LATE_OFFER = afterStill(
  `<button>seen</button>
  <div id="offer" hidden style="opacity: 0; transition: opacity 0.2s 3s"><button>Save a passkey</button></div>`,
  `const offer = document.getElementById('offer');
  offer.hidden = false;
  offer.getBoundingClientRect();
  offer.style.opacity = '1';`,
);

/** A control in its place throughout that fades in late, after 3 s at opacity 0: no box moves,
 *  so only a motion running tells it isn't at rest. */
const LATE_FADE = afterStill(
  '<button>seen</button><button id="soft" style="opacity: 0; transition: opacity 0.2s 3s">Soft</button>',
  "document.getElementById('soft').style.opacity = '1';",
);

/** A control a script moves in late, 100 px a frame from 1000 px off screen: no motion on the
 *  page's timeline, so only its box moving tells it isn't at rest. */
const LATE_MOVE = afterStill(
  '<button>seen</button><button id="moved" style="position: fixed; top: 20px; left: -1000px">Moved</button>',
  `const moved = document.getElementById('moved');
  const step = (left) => {
    moved.style.left = left + 'px';
    if (left < 200) {
      requestAnimationFrame(() => {
        step(left + 100);
      });
    }
  };
  requestAnimationFrame(() => {
    step(-900);
  });`,
);

/** In one engine: each late page judged once at rest, and a page under a paused page clock, whose
 *  frames never come. */
const atRest = async (engine: BrowserType): Promise<readonly (readonly string[])[]> => {
  const browser = await engine.launch();
  try {
    const late = await Promise.all(
      [LATE_OFFER, LATE_FADE, LATE_MOVE].map(async (html) => {
        const page = await browser.newPage();
        await page.setContent(html);
        return invisibleFocusables(page);
      }),
    );
    const paused = await browser.newPage();
    await paused.clock.install();
    await paused.clock.pauseAt(Date.now() + 60_000);
    await paused.setContent(
      '<main><button>seen</button><button style="opacity: 0">faded</button></main>',
    );
    return [...late, await invisibleFocusables(paused)];
  } finally {
    await browser.close();
  }
};

await Promise.all(
  ENGINES.map(async ([name, engine]) =>
    test(`${name}: controls are judged at rest: an offer opened, a fade begun and a box moved after the wait for stillness, and a paused clock's page`, async () => {
      assert.deepEqual(await atRest(engine), [
        [],
        [],
        [],
        ['<button> "faded" takes focus but cannot be seen'],
      ]);
    }),
  ),
);
