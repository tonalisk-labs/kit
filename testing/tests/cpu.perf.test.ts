// A page's main-thread CPU time, as Chromium reports it: what the page's own work costs, which a
// page waiting on a timer does not spend, however long the wall clock runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chromium } from '@playwright/test';

import { pageCpuClock } from '../src/index.ts';

await test('a page’s CPU time counts its work, and none of its waiting', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>a page</p>');
    const waiting = await pageCpuClock(page);
    assert.ok(waiting !== undefined, 'Chromium reports its main thread’s time');
    await page.evaluate(async () => {
      await new Promise((done) => {
        globalThis.setTimeout(done, 400);
      });
    });
    const waited = (await waiting()) ?? Number.NaN;
    const working = await pageCpuClock(page);
    assert.ok(working !== undefined);
    // A fixed amount of work, not a span of time: a busy machine slows it, never shortens it.
    const sum = await page.evaluate(() => {
      let total = 0;
      for (let at = 0; at < 400_000_000; at += 1) {
        total += Math.sqrt(at);
      }
      return total;
    });
    assert.ok(sum > 0);
    const worked = (await working()) ?? Number.NaN;
    assert.ok(waited < 50, `${String(Math.round(waited))} ms of CPU while waiting`);
    assert.ok(worked > 4 * waited + 100, `${String(Math.round(worked))} ms of CPU while working`);
  } finally {
    await browser.close();
  }
});

await test('under Chromium’s CPU throttling a page’s count is mostly the throttle’s', async () => {
  // Why kit counts CPU time on full-speed rows alone: a throttled page spends CPU while it waits.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p>a page</p>');
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const waiting = await pageCpuClock(page);
    assert.ok(waiting !== undefined);
    await page.evaluate(async () => {
      await new Promise((done) => {
        globalThis.setTimeout(done, 400);
      });
    });
    const waited = (await waiting()) ?? Number.NaN;
    assert.ok(waited > 100, `${String(Math.round(waited))} ms of CPU while waiting, throttled`);
  } finally {
    await browser.close();
  }
});
