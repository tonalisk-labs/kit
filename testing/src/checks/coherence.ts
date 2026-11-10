import { expect, type Locator, type Page } from '@playwright/test';

import type { Row } from '../matrix.ts';
import { baseline } from '../visual.ts';
import { axeFindings } from './axe.ts';
import { designFindings, focusRingOf, type Scale } from './design.ts';
import { focusRings } from './focus.ts';
import { type Geometry, geometryOf, layoutFindings, parity, type Toasts } from './layout.ts';
import { inEveryMode } from './modes.ts';
import { oneByOne, settle, type Theme, toTheme } from './themes.ts';

/** How a target's screens are looked at: its design system, its notices, what varies by run. */
export interface Look {
  readonly page: Page;
  readonly row: Row;
  readonly scale: Scale;
  /** In the visual projects a screen with a baseline is compared with it, and no rule runs. */
  readonly visual: boolean;
  readonly toasts: Toasts | undefined;
  /** What every baseline masks: text that differs run to run, such as server-written dates. */
  readonly masks: (page: Page) => readonly Locator[];
  /** CSS selectors every baseline draws invisible, where a mask would paint over a dialog. */
  readonly hidden?: string;
  /** What comes and goes on its own (notices, work in flight): gone before a baseline. */
  readonly transient: (page: Page) => Locator;
}

export interface Screen {
  /** Names the screen in messages and its baseline, `<form>/<name>-<theme>.png`. */
  readonly name: string;
  readonly baseline?: boolean;
  /** What this screen's baseline masks besides the look's own. */
  readonly masks?: readonly Locator[];
  /** A theme chosen in the app, which overrides the system's: the screen is checked in it alone. */
  readonly chosen?: Theme;
}

/** Each sweep's findings by rule and screen, all held at its end, so a sweep shows all it gets
 *  wrong in one assertion. */
const unmet = new WeakMap<Look, Record<string, readonly string[]>>();

const hold = (look: Look, findings: readonly string[], rule: string): void => {
  const found = unmet.get(look);
  if (found !== undefined && findings.length > 0) {
    found[rule] = findings;
  }
};

/** Every rule, each held apart. */
const judge = async (look: Look, label: string): Promise<void> => {
  const { page, row } = look;
  const design = await designFindings(page, look.scale);
  hold(look, design.typography, `text on the default scale: ${label}`);
  hold(look, design.palette, `colours from the default palette: ${label}`);
  hold(look, await axeFindings(page), `axe-core at its strictest: ${label}`);
  hold(look, design.glued, `a space between words: ${label}`);
  hold(look, design.fonts, `no web font but the site's own (kit's siteFont): ${label}`);
  hold(look, design.flash, `web fonts preloaded and displayed optional, never flashing: ${label}`);
  for (const line of design.reported) {
    console.log(`  ${label}: ${line}`);
  }
  const touch = row.form === 'tablet' || row.form === 'phone';
  const layout = await layoutFindings(page, { touch, toasts: look.toasts });
  hold(look, layout.modals, `modals centred, drawers pinned: ${label}`);
  hold(look, layout.overlays, `open overlays shown whole: ${label}`);
  hold(look, layout.toasts, `notices centred where they belong: ${label}`);
  hold(look, layout.overflow, `nothing scrolls sideways: ${label}`);
  hold(look, layout.clipped, `no content cut off: ${label}`);
  hold(look, layout.overlap, `no control over another: ${label}`);
  hold(look, layout.obscured, `the focused control never hidden by a notice: ${label}`);
  hold(look, layout.targets, `touch targets of 44 × 44: ${label}`);
};

/** The pointer away in the viewport's bottom-left corner, so no hover is drawn. */
const pointerAway = async (page: Page): Promise<void> => {
  const size = page.viewportSize();
  await page.mouse.move(0, size === null ? 0 : size.height - 1);
};

/** No element keeps focus: every screen is captured in the same focus state, whichever control
 *  the app autofocused or a keyboard last reached. */
const blurred = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const focused = globalThis.document.activeElement;
    if (focused instanceof globalThis.HTMLElement) {
      focused.blur();
    }
  });
};

const snap = async (look: Look, screen: Screen, theme: Theme): Promise<void> => {
  const { page, row } = look;
  await pointerAway(page);
  await blurred(page);
  // A notice lives as long as the site says, so its leaving is bounded by the test's own time.
  await expect(look.transient(page)).toHaveCount(0, { timeout: 0 });
  await settle(page);
  const mask = [...look.masks(page), ...(screen.masks ?? [])];
  const differs = await baseline(page, [row.form, `${screen.name}-${theme}.png`], {
    mask,
    hide: look.hidden ?? '',
  });
  hold(look, differs, `the baseline: ${screen.name} (${theme})`);
};

/** One theme: its baseline in the visual projects, else its rules and the boxes it lays out. */
const inTheme = async (look: Look, screen: Screen, theme: Theme): Promise<Geometry> => {
  await (screen.chosen === undefined ? toTheme(look.page, theme) : settle(look.page));
  if (look.visual) {
    if (screen.baseline === true) {
      await snap(look, screen, theme);
    }
    return {};
  }
  await judge(look, `${screen.name} (${theme})`);
  return geometryOf(look.page, look.toasts === undefined ? '' : look.toasts.selector);
};

const rings = async (look: Look, screen: Screen, theme: Theme): Promise<void> => {
  if (screen.chosen === undefined) {
    await toTheme(look.page, theme);
  }
  const found = await focusRings(look.page, focusRingOf);
  hold(look, found, `focus rings at 3:1: ${screen.name} (${theme})`);
};

/** Checks one screen in each theme: its rules, the same boxes in both, focus rings, and every mode
 *  of checks/modes.ts, or its baselines in the visual projects. Leaves the page in the light one. */
export const sweep = async (look: Look, screen: Screen): Promise<void> => {
  unmet.set(look, {});
  const themes: readonly Theme[] =
    screen.chosen === undefined ? ['light', 'dark'] : [screen.chosen];
  const [light, dark] = await oneByOne(themes, async (theme) => inTheme(look, screen, theme));
  if (!look.visual) {
    if (light !== undefined && dark !== undefined) {
      hold(look, parity(light, dark), `the same layout in both themes: ${screen.name}`);
    }
    await oneByOne(themes.toReversed(), async (theme) => rings(look, screen, theme));
    const { page, row, toasts } = look;
    const followed = screen.chosen === undefined ? themes : [];
    await inEveryMode({ page, row, toasts, themes: followed }, (findings, rule) => {
      hold(look, findings, `${rule}: ${screen.name}`);
    });
  }
  if (screen.chosen === undefined) {
    await toTheme(look.page, 'light');
  }
  const found = unmet.get(look);
  unmet.delete(look);
  expect(found, screen.name).toEqual({});
};
