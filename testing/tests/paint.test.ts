// The design rules read colours back from a canvas in the page, where CSS parses them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import { inPage } from '../src/checks/in-page.ts';
import { pen, rgba } from '../src/checks/paint.ts';

await test('a colour the page cannot parse reads as black, not as the colour read before it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const read = await inPage(page, { pen, rgba })(() => [rgba('red'), rgba('not a colour')]);
    assert.deepEqual(read, [
      [255, 0, 0, 1],
      [0, 0, 0, 1],
    ]);
  } finally {
    await browser.close();
  }
});
