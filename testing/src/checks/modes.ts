/* A screen as people who change how pages show see it: with motion reduced, colours forced, more
 *  contrast, text spaced out (WCAG 1.4.12) and, on a phone, a window 320 px wide (WCAG 1.4.10).
 *  Each is applied, judged and taken back, so the page is left as it was. Page-side functions name
 *  only the helpers `inPage` puts in scope: Playwright sends each source alone. */
import type { Page } from '@playwright/test';

import type { Row } from '../matrix.ts';
import { axeFindings, MORE_CONTRAST, MORE_CONTRAST_BAR } from './axe.ts';
import { focusRingOf } from './design.ts';
import { focusRings } from './focus.ts';
import { inPage } from './in-page.ts';
import { geometryOf, layoutFindings, parity, type Toasts } from './layout.ts';
import { untilStill } from './still.ts';
import { oneByOne, type Theme, toTheme } from './themes.ts';

/** What the modes judge on a screen, as the sweep's look gives it. */
export interface Viewed {
  readonly page: Page;
  readonly row: Row;
  readonly toasts: Toasts | undefined;
  /** The system themes the screen follows, each judged with more contrast; none for a screen
   *  that keeps a theme of its own, judged as it is. */
  readonly themes?: readonly Theme[];
}

/** A rule's findings under a label, each rule held apart (the sweep's `hold`). */
export type Hold = (findings: readonly string[], rule: string) => void;

/** The properties whose change moves or resizes a box, as a pattern's source for the page. */
const MOVES = String.raw`^(?:all|transform|translate|rotate|scale|offset(?:-[a-z]+)*|inset(?:-[a-z]+)*|top|right|bottom|left|margin(?:-[a-z]+)*|width|height|background-position(?:-[xy])?)$`;

/** A keyframe's own keys, which name no property it animates. */
const KEYFRAME_KEYS = ['offset', 'computedOffset', 'easing', 'composite'];

/** In the page: an element as a finding names it, by its tag and its first words or label; the
 *  document's root and body by their tags alone. */
const nameOf = (element: Element): string => {
  const { documentElement, body } = globalThis.document;
  if (element === documentElement || element === body) {
    return `<${element.localName}>`;
  }
  const text = element.textContent.trim().replaceAll(/\s+/gu, ' ').slice(0, 40);
  return `<${element.localName}> "${text === '' ? (element.getAttribute('aria-label') ?? '') : text}"`;
};

/** In the page: a computed duration, `0.15s`, in seconds. */
const seconds = (time: string): number =>
  time.endsWith('ms') ? Number(time.slice(0, -2)) / 1000 : Number(time.slice(0, -1));

/** In the page, under reduced motion: animations of a box's place or size, transitions of nothing
 *  else (or of `all`), and smooth scrolling. Transitions that also fade or recolour (most) pass. */
const motionIn = (): string[] => {
  const moves = new RegExp(MOVES, 'u');
  const { document } = globalThis;
  const animated = document.getAnimations().flatMap((animation) => {
    const { effect, playState } = animation;
    if (playState !== 'running' || !(effect instanceof globalThis.KeyframeEffect)) {
      return [];
    }
    const moved = effect
      .getKeyframes()
      .flatMap((frame) => Object.keys(frame))
      .filter((key) => !KEYFRAME_KEYS.includes(key))
      .find((property) =>
        moves.test(property.replaceAll(/[A-Z]/gu, (up) => `-${up.toLowerCase()}`)),
      );
    const { target } = effect;
    return moved === undefined || target === null
      ? []
      : [`${nameOf(target)} runs an animation of its ${moved}`];
  });
  const transitioned = [...document.querySelectorAll('*')].flatMap((element) => {
    const style = globalThis.getComputedStyle(element);
    const properties = style.transitionProperty.split(',').map((property) => property.trim());
    const durations = style.transitionDuration.split(',').map((time) => seconds(time.trim()));
    const timed = properties.filter(
      (_property, at) => (durations[at % durations.length] ?? 0) > 0.01,
    );
    return timed.length > 0 && timed.every((property) => moves.test(property))
      ? [`${nameOf(element)} moves its ${timed.join(', ')} as it changes`]
      : [];
  });
  const smooth = [document.documentElement, document.body, ...document.querySelectorAll('*')]
    .filter((element) => globalThis.getComputedStyle(element).scrollBehavior === 'smooth')
    .map((element) => `${nameOf(element)} scrolls smoothly`);
  return [...animated, ...new Set(transitioned), ...new Set(smooth)];
};

/** What still moves on the page under reduced motion (`motionIn`). */
export const motionFindings = async (page: Page): Promise<string[]> =>
  inPage(page, { MOVES, KEYFRAME_KEYS, nameOf, seconds })(motionIn);

/** In the page: WCAG 1.4.12's text spacing over the page's own styles, or taken back. A
 *  constructed sheet, as the page's CSP refuses an inline one. */
const spaceText = (on: boolean): void => {
  const { document } = globalThis;
  const key = Symbol.for('sites.testing.text-spacing');
  const held: unknown = Reflect.get(globalThis, key);
  const sheet = held instanceof globalThis.CSSStyleSheet ? held : new globalThis.CSSStyleSheet();
  if (!(held instanceof globalThis.CSSStyleSheet)) {
    sheet.replaceSync(
      [
        '*, *::before, *::after { line-height: 1.5 !important; letter-spacing: 0.12em !important;',
        'word-spacing: 0.16em !important; }',
        'p { margin-block-end: 2em !important; }',
      ].join(' '),
    );
    Reflect.set(globalThis, key, sheet);
  }
  const others = document.adoptedStyleSheets.filter((one) => one !== sheet);
  document.adoptedStyleSheets = on ? [...others, sheet] : others;
};

/** WCAG 1.4.10's reflow width: a 1280 px window zoomed to 400%. */
const REFLOW_PX = 320;

const settled = async (page: Page): Promise<void> => {
  await untilStill(page);
};

/** Under reduced motion, nothing moves. */
const reduced = async ({ page }: Viewed, hold: Hold): Promise<void> => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settled(page);
  hold(await motionFindings(page), 'nothing moves under reduced motion (WCAG 2.3.3)');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settled(page);
};

/** With colours forced, every focus ring still shows: a box shadow, which forced colours drop,
 *  is no ring there. Judged where the engine forces colours. */
const forced = async ({ page }: Viewed, hold: Hold): Promise<void> => {
  await page.emulateMedia({ forcedColors: 'active' });
  const applies = await page.evaluate(
    () => globalThis.matchMedia('(forced-colors: active)').matches,
  );
  if (applies) {
    await settled(page);
    hold(await focusRings(page, focusRingOf), 'focus rings at 3:1 with colours forced');
  }
  await page.emulateMedia({ forcedColors: 'none' });
  await settled(page);
};

const MORE_CONTRAST_RULE = `text at ${String(MORE_CONTRAST_BAR)}:1 with more contrast, as Apple's`;

/** With Increase Contrast asked for, text holds MORE_CONTRAST in each theme the screen follows,
 *  where the engine applies it, and the system's theme is put back after. */
const more = async ({ page, themes = [] }: Viewed, hold: Hold): Promise<void> => {
  await page.emulateMedia({ contrast: 'more' });
  const applies = await page.evaluate(
    () => globalThis.matchMedia('(prefers-contrast: more)').matches,
  );
  if (applies) {
    await settled(page);
    if (themes.length === 0) {
      hold(await axeFindings(page, MORE_CONTRAST), MORE_CONTRAST_RULE);
    } else {
      const dark = await page.evaluate(
        () => globalThis.matchMedia('(prefers-color-scheme: dark)').matches,
      );
      await oneByOne(themes, async (theme) => {
        await toTheme(page, theme);
        hold(await axeFindings(page, MORE_CONTRAST), `${MORE_CONTRAST_RULE} (${theme})`);
      });
      await toTheme(page, dark ? 'dark' : 'light');
    }
  }
  await page.emulateMedia({ contrast: 'no-preference' });
  await settled(page);
};

/** The layout rules a person who changed how text or the window shows still holds the page to. */
const unbroken = async (
  { page, row, toasts }: Viewed,
  hold: Hold,
  under: string,
): Promise<void> => {
  const touch = row.form === 'tablet' || row.form === 'phone';
  const layout = await layoutFindings(page, { touch, toasts });
  hold(layout.overflow, `nothing scrolls sideways ${under}`);
  hold(layout.clipped, `no content cut off ${under}`);
  hold(layout.overlap, `no control over another ${under}`);
};

/** With text spaced out, nothing is cut off or overlaps. */
const spaced = async (viewed: Viewed, hold: Hold): Promise<void> => {
  const { page } = viewed;
  await page.evaluate(spaceText, true);
  await settled(page);
  await unbroken(viewed, hold, 'with text spaced out (WCAG 1.4.12)');
  await page.evaluate(spaceText, false);
  await settled(page);
};

/** On a phone, whose layout a 320 px window shows (a wider form would cross breakpoints): nothing
 *  scrolls sideways, is cut off or overlaps there, and the layout is the same once back. */
const narrow = async (viewed: Viewed, hold: Hold): Promise<void> => {
  const { page, row, toasts } = viewed;
  const size = page.viewportSize();
  if (row.form !== 'phone' || size === null || size.width <= REFLOW_PX) {
    return;
  }
  const notices = toasts === undefined ? '' : toasts.selector;
  const before = await geometryOf(page, notices);
  await page.setViewportSize({ width: REFLOW_PX, height: size.height });
  await settled(page);
  await unbroken(viewed, hold, `${String(REFLOW_PX)} px wide (WCAG 1.4.10)`);
  await page.setViewportSize(size);
  await settled(page);
  const after = await geometryOf(page, notices);
  hold(
    parity(before, after, ['before', 'once back']),
    `the same layout once back from ${String(REFLOW_PX)} px`,
  );
};

/** Every mode, one at a time, each taken back before the next. */
export const inEveryMode = async (viewed: Viewed, hold: Hold): Promise<void> => {
  await reduced(viewed, hold);
  await forced(viewed, hold);
  await more(viewed, hold);
  await spaced(viewed, hold);
  await narrow(viewed, hold);
};
