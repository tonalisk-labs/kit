import type { Page } from '@playwright/test';

/** A process that answered the reading before a navigation swapped it starts its count anew. */
export const cpuSince = (before: number, after: number): number =>
  after >= before ? after - before : after;

/** The main thread's CPU time from now, in ms (Chromium's `ThreadTime`, none elsewhere), which a
 *  busy machine does not stretch. Throttling busies the thread too, so time full-speed pages. */
export const pageCpuClock = async (
  page: Page,
): Promise<(() => Promise<number | undefined>) | undefined> => {
  const browser = page.context().browser();
  const engine = browser === null ? undefined : browser.browserType().name();
  if (engine !== 'chromium') {
    return undefined;
  }
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const threadTime = async (): Promise<number | undefined> => {
    const { metrics } = await session.send('Performance.getMetrics');
    const found = metrics.find(({ name }) => name === 'ThreadTime');
    return found === undefined ? undefined : found.value;
  };
  const before = await threadTime();
  return async () => {
    const after = await threadTime();
    await session.detach();
    return before === undefined || after === undefined ? undefined : cpuSince(before, after) * 1000;
  };
};
