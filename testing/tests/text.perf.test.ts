// Run alone and uninstrumented, its budget in CPU time, as every timed test is.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import { overlaps, textLines, type TextLine } from '../src/checks/text.ts';
import { pageCpuClock } from '../src/perf/cpu.ts';
import { cpuClock } from './cpu.ts';

const lineAt = (
  [left, top]: readonly [number, number],
  lineage: string,
  text: string,
): TextLine => ({
  left,
  top,
  right: left + 40,
  bottom: top + 10,
  clips: [],
  lineage,
  text,
});

await test('a long list of lines is checked in linear time, not by copying every tail', () => {
  const lines = Array.from({ length: 20_000 }, (_line, at) =>
    lineAt([0, at * 20], `/0/${String(at)}`, `item ${String(at)}`),
  );
  const spent = cpuClock();
  assert.deepEqual(overlaps(lines), []);
  const took = spent();
  assert.ok(took < 100, `${String(Math.round(took))} ms of CPU`);
});

await test("each line's lineage is its owner's place among its ancestors' children", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const items = Array.from({ length: 2000 }, (_item, at) => `<li>item ${String(at)}</li>`);
    await page.setContent(
      `<main><p>lead</p><ul>${items.join('')}</ul><div><span>a</span><b>b</b></div></main>`,
    );
    const spent = await pageCpuClock(page);
    assert.ok(spent !== undefined, 'Chromium reports its main thread’s time');
    const lines = await textLines(page);
    const took = (await spent()) ?? Number.NaN;
    const lineages = new Map(lines.map(({ text, lineage }) => [text, lineage]));
    const lineageOf = (text: string): string => lineages.get(text) ?? '';
    assert.equal(lineageOf('lead'), '/0/1/0/0');
    assert.equal(lineageOf('item 0'), '/0/1/0/1/0');
    assert.equal(lineageOf('item 1999'), '/0/1/0/1/1999');
    assert.equal(lineageOf('a'), '/0/1/0/2/0');
    assert.equal(lineageOf('b'), '/0/1/0/2/1');
    assert.ok(took < 500, `${String(Math.round(took))} ms of the page's CPU`);
  } finally {
    await browser.close();
  }
});
