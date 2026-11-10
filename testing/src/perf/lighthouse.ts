import type { Page } from '@playwright/test';
import { startFlow } from 'lighthouse';
import puppeteer, { type Browser, type Page as PuppeteerPage } from 'puppeteer-core';

type Flow = Awaited<ReturnType<typeof startFlow>>;
export type FlowResult = Awaited<ReturnType<Flow['createFlowResult']>>;

/** The page's emulation as the project set it, which Puppeteer re-applies as it attaches. */
interface Emulation {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

export interface FlowOptions {
  /** The DevTools port of the very Chromium the test drives. */
  readonly cdpPort: number;
  readonly emulation: Emulation;
  readonly categories: readonly string[];
  readonly formFactor: 'mobile' | 'desktop';
}

const targetIdOf = async (page: Page): Promise<string> => {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await session.detach();
  }
};

const samePage = async (browser: Browser, targetId: string): Promise<PuppeteerPage> => {
  const ids = await Promise.all(
    browser.targets().map(async (target) => {
      const session = await target.createCDPSession();
      const { targetInfo } = await session.send('Target.getTargetInfo');
      await session.detach();
      return [targetInfo.targetId, target] as const;
    }),
  );
  const [, target] = ids.find(([id]) => id === targetId) ?? [];
  const page = target === undefined ? undefined : await target.page();
  if (page === undefined || page === null) {
    throw new Error(`Lighthouse found no tab with target ${targetId}`);
  }
  return page;
};

/** Runs Lighthouse user-flow steps in the test's own tab and Chromium, so it sees the real state;
 *  Lighthouse neither emulates a screen nor throttles, and leaves storage alone. */
export const withFlow = async (
  page: Page,
  options: FlowOptions,
  steps: (flow: Flow) => Promise<void>,
): Promise<FlowResult> => {
  const targetId = await targetIdOf(page);
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${String(options.cdpPort)}`,
    defaultViewport: Object.assign(structuredClone(options.emulation), {
      isLandscape: options.emulation.width > options.emulation.height,
    }),
  });
  try {
    const flow = await startFlow(await samePage(browser, targetId), {
      config: {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: [...options.categories],
          formFactor: options.formFactor,
          screenEmulation: { disabled: true },
          emulatedUserAgent: false,
          throttlingMethod: 'provided',
          disableStorageReset: true,
        },
      },
    });
    await steps(flow);
    return await flow.createFlowResult();
  } finally {
    await browser.disconnect();
  }
};
