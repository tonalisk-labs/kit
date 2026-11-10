import { stripVTControlCharacters } from 'node:util';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { diffSummary } from './checks/visual-diff.ts';

/** The architecture the baselines were drawn on: Playwright's Linux image on Apple silicon. It
 *  names their folder, and a visual run elsewhere refuses to start. */
export const BASELINE_ARCH = 'arm64';

/** The visual projects' motion. A dialog's open transition rasterises its layer at a whole-pixel
 *  origin, which nothing redraws once it ends: its first shot sat a fraction off its repaint. */
export const VISUAL_MOTION = 'reduce';

/** The screenshot's attachments Playwright adds when it fails a baseline. */
const attached = (name: string, from: number): string | undefined => {
  const found = test
    .info()
    .attachments.slice(from)
    .find((attachment) => attachment.name.endsWith(name));
  return found === undefined ? undefined : found.path;
};

interface Size {
  readonly width: number;
  readonly height: number;
}

/** In the page: its whole size, as Playwright's full-page screenshot measures it. */
const pageSize = (): Size => {
  const { body, documentElement: root } = globalThis.document;
  const most = (side: 'Width' | 'Height'): number =>
    Math.max(
      body[`scroll${side}`],
      root[`scroll${side}`],
      body[`offset${side}`],
      root[`offset${side}`],
      body[`client${side}`],
      root[`client${side}`],
    );
  return { width: most('Width'), height: most('Height') };
};

const fits = (page: Size, viewport: Size): boolean =>
  page.width <= viewport.width && page.height <= viewport.height;

const sized = ({ width, height }: Size): string => `${String(width)}×${String(height)}`;

/** An element in document order, and its box on the page while it is drawn. */
type Drawn = readonly [name: string, box: readonly number[] | undefined];

/** In the page, scrolled to its top: each element and the box it is drawn in. */
const drawnBoxes = (): Drawn[] =>
  [...globalThis.document.querySelectorAll('body *')].map((element) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    const drawn =
      width > 0 && height > 0 && globalThis.getComputedStyle(element).visibility === 'visible';
    const name = `<${element.localName}${element.id === '' ? '' : `#${element.id}`}>`;
    return [name, drawn ? [left, top, width, height] : undefined];
  });

/** A drawn box may move this much as the page grows to a whole pixel: the column `m-auto` centres. */
const MOVE_PX = 1;

const shown = (box: readonly number[] | undefined): string =>
  box === undefined ? 'not drawn' : box.map((side) => side.toFixed(1)).join(' ');

/** Each element drawn in either list whose box moves more than `MOVE_PX` between them. */
const movedOf = (before: readonly Drawn[], after: readonly Drawn[]): string[] =>
  before.flatMap(([name, box], at) => {
    const [, other] = after[at] ?? ['', undefined];
    const still =
      box === undefined || other === undefined
        ? box === other
        : box.every((side, index) => Math.abs(side - (other[index] ?? Number.NaN)) <= MOVE_PX);
    return still ? [] : [`${name} from ${shown(box)} to ${shown(other)}`];
  });

/** `capture` in the viewport `grown` to the page, the page at its top and scrolled back after. A
 *  page that outgrows it, or a drawn box it moves, fails it uncaptured. */
const inGrownViewport = async <Shot>(
  page: Page,
  { viewport, grown }: { readonly viewport: Size; readonly grown: Size },
  capture: () => Promise<Shot>,
): Promise<Shot> => {
  const scrolled = await page.evaluate(() => [globalThis.scrollX, globalThis.scrollY] as const);
  await page.evaluate(() => {
    globalThis.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  });
  const before = await page.evaluate(drawnBoxes);
  await page.setViewportSize(grown);
  try {
    const now = await page.evaluate(pageSize);
    if (!fits(now, grown)) {
      throw new Error(
        `the page, ${sized(now)}, outgrows the viewport grown to it, ${sized(grown)}`,
      );
    }
    const moved = movedOf(before, await page.evaluate(drawnBoxes));
    if (moved.length > 0) {
      throw new Error(`the viewport grown to the page moves ${moved.slice(0, 3).join(', ')}`);
    }
    return await capture();
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate(([left, top]) => {
      globalThis.scrollTo({ left, top, behavior: 'instant' });
    }, scrolled);
  }
};

/** `capture` on a touch screen, the viewport as tall as the page: Chromium paints a capture beyond
 *  it with touch off. A page wider than the screen fails, as a wider viewport would lay it out anew. */
export const atPageHeight = async <Shot>(
  page: Page,
  capture: () => Promise<Shot>,
): Promise<Shot> => {
  const viewport = page.viewportSize();
  const touch =
    viewport !== null && (await page.evaluate(() => globalThis.navigator.maxTouchPoints > 0));
  const size = touch ? await page.evaluate(pageSize) : undefined;
  if (viewport === null || size === undefined || fits(size, viewport)) {
    return capture();
  }
  if (size.width > viewport.width) {
    throw new Error(`the page, ${sized(size)}, is wider than its ${sized(viewport)} touch screen`);
  }
  const grown = { width: viewport.width, height: size.height };
  return inGrownViewport(page, { viewport, grown }, capture);
};

const NO_BASELINE =
  "no baseline to compare with: approve one with npx playwright test --project='*/visual-*' --update-snapshots";

/** A message's lines, trimmed of their indent and a call log's bullet. */
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/^- /u, ''))
    .filter((line) => line !== '');

/** Why no screenshot was compared, in the failure's own words, and the call log's last failed
 *  capture: a capture that never held still, or one that threw on every attempt. */
export const reasonOf = (error: unknown): string => {
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  const [words = '', log = ''] = message.split('\nCall log:');
  const failed = lines(log).findLast((line) => line.startsWith('failed to take screenshot'));
  return [...lines(words), ...(failed === undefined ? [] : [failed])].join(' ');
};

/** The images Playwright attached as a comparison failed, by their names' endings. */
interface Shots {
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  readonly previous: string | undefined;
}

/** What a failed comparison says: the pixels that differ, a missing baseline, or the failure. A
 *  capture that never held still leaves its last two shots, and no baseline it can approve. */
export const verdictOf = ({ expected, actual, previous }: Shots, error: unknown): string => {
  if (expected !== undefined && actual !== undefined) {
    return diffSummary(expected, actual);
  }
  return expected === undefined && actual !== undefined && previous === undefined
    ? NO_BASELINE
    : reasonOf(error);
};

/** How the page differs from its baseline, if it does: whole page, or viewport alone under a modal,
 *  at the device pixel ratio, no pixel apart, `hide` selectors made invisible, not masked over. */
export const baseline = async (
  page: Page,
  name: readonly string[],
  { mask, hide }: { readonly mask: readonly Locator[]; readonly hide: string },
): Promise<readonly string[]> => {
  const attachments = test.info().attachments.length;
  const modal = await page.locator('dialog:modal').count();
  const style = hide === '' ? {} : { style: `${hide} { visibility: hidden !important; }` };
  const options = { fullPage: modal === 0, scale: 'device' as const, mask: [...mask] };
  const shot = async (): Promise<void> => {
    await expect(page).toHaveScreenshot([...name], Object.assign(options, style));
  };
  try {
    await (modal === 0 ? atPageHeight(page, shot) : shot());
    return [];
  } catch (error) {
    const shots = {
      expected: attached('-expected.png', attachments),
      actual: attached('-actual.png', attachments),
      previous: attached('-previous.png', attachments),
    };
    return [verdictOf(shots, error)];
  }
};
