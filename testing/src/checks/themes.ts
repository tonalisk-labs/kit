// The light and dark themes a screen is judged in, the move from one to the other, and work done
// one item after another, as the sweep and the modes each step through them.
import { expect, type Page } from '@playwright/test';

import { untilStill } from './still.ts';

export type Theme = 'light' | 'dark';

/** The page at rest: its work ended, as that restyles its controls (a button leaving its busy
 *  look), then still. */
export const settle = async (page: Page): Promise<void> => {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await untilStill(page);
};

/** The system's theme, which the page follows (its `color-scheme` says it has). */
export const toTheme = async (page: Page, theme: Theme): Promise<void> => {
  await page.emulateMedia({ colorScheme: theme });
  await expect(page.locator(':root')).toHaveCSS('color-scheme', theme);
  await settle(page);
};

/** Each item's action, the next once the last has ended. */
export const oneByOne = async <Item, Result>(
  items: readonly Item[],
  action: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const [first, ...rest] = items;
  return first === undefined ? [] : [await action(first), ...(await oneByOne(rest, action))];
};
