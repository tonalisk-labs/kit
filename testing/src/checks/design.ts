import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';
import { BODY_FONT } from '../../../theme/fonts/variable.ts';

import { backdrop, backdropOf, contrastOf, luminance, over, pageCanvas } from './contrast.ts';
import { familiesOf, filesOf, firstFamily, flashIn } from './fonts.ts';
import {
  boxesOf,
  edgeText,
  edgesOf,
  edgesOfText,
  floated,
  gluedIn,
  gluedPair,
  mayGlue,
  shownText,
  touches,
} from './glue.ts';
import { inPage } from './in-page.ts';
import {
  clippedAway,
  emptyMemo,
  type Memo,
  pen,
  pixels,
  type Rgba,
  rgba,
  rgbaIn,
} from './paint.ts';
import { holdStill, untilStill } from './still.ts';

/** The design system a target is held to: Tailwind's default text sizes and palette. */
export interface Scale {
  /** The text sizes, in rem: `text-xs` to `text-9xl`. */
  readonly text: readonly number[];
  /** The palette, as CSS colours: every `--color-*`, white and black included. */
  readonly colours: readonly string[];
  /** Colour themes' own scales, by the `data-palette` value that applies each: allowed only
   *  where that theme is in force, on the element that names it and within. */
  readonly themes?: Readonly<Record<string, readonly string[]>>;
}

export interface DesignFindings {
  readonly typography: readonly string[];
  readonly palette: readonly string[];
  readonly glued: readonly string[];
  readonly fonts: readonly string[];
  /** Web fonts that could flash: a face not displayed `optional`, or not preloaded. */
  readonly flash: readonly string[];
  /** Non-text contrast below 3:1 (control boundaries): printed, not held. */
  readonly reported: readonly string[];
}

/* Page-side functions run through `inPage` with this kit in scope. Colours are read back from a
 *  1×1 canvas, so oklch, oklab and color-mix compare as sRGB. SVG and clipped-away text are out. */

const hex = ([red, green, blue, alpha]: Rgba): string => {
  const channels = [red, green, blue].map((channel) =>
    Math.round(channel).toString(16).padStart(2, '0'),
  );
  return `#${channels.join('')}${alpha < 1 ? ` at ${alpha.toFixed(2)}` : ''}`;
};

/** The elements that own visible text, found once per `designFindings` call: `run` names the
 *  call, and the page holds still across its rules. */
const textOwners = (seen: Memo, run?: string): HTMLElement[] => {
  const key = Symbol.for('sites.testing.owners');
  const held: unknown = Reflect.get(globalThis, key);
  if (run !== undefined && held instanceof Map && held.has(run)) {
    const owners: unknown = held.get(run);
    if (Array.isArray(owners)) {
      return owners.filter((owner) => owner instanceof globalThis.HTMLElement);
    }
  }
  const found = findOwners(seen);
  if (run !== undefined) {
    Object.defineProperty(globalThis, key, { value: new Map([[run, found]]), configurable: true });
  }
  return found;
};

const findOwners = (seen: Memo): HTMLElement[] => {
  const { document } = globalThis;
  const walker = document.createTreeWalker(document.body, globalThis.NodeFilter.SHOW_TEXT);
  const owners = new Set<HTMLElement>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      parent instanceof globalThis.HTMLElement &&
      (node.textContent ?? '').trim() !== '' &&
      parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      owners.add(parent);
    }
  }
  return [...owners].filter((owner) => !clippedAway(owner, seen));
};

const named = (element: Element): string => {
  const text = element.textContent.trim().replaceAll(/\s+/gu, ' ').slice(0, 40);
  const label = element.getAttribute('aria-label') ?? '';
  return `<${element.localName}> "${text === '' ? label : text}"`;
};

/** Behind an open modal: inert, and seen only through its backdrop, so not judged. */
const covered = (element: Element): boolean => {
  const modal = globalThis.document.querySelector('dialog:modal');
  return modal !== null && !modal.contains(element);
};

const inactive = (element: Element): boolean =>
  element.closest(':disabled, [aria-disabled="true"]') !== null || covered(element);

/** Text off the scale: each owner's font size against every `rem` size at the root's size. */
const typographyIn = ({ text, run }: { text: readonly number[]; run: string }): string[] => {
  const root = pixels(globalThis.getComputedStyle(globalThis.document.documentElement).fontSize);
  return textOwners(emptyMemo(), run).flatMap((owner) => {
    const size = pixels(globalThis.getComputedStyle(owner).fontSize);
    return text.some((rem) => Math.abs(rem * root - size) < 0.05)
      ? []
      : [`${named(owner)} is ${size.toFixed(2)}px, off the text scale`];
  });
};

/** A translucent colour is read back less exactly, the fainter it is. */
const inPalette = (colour: Rgba, palette: readonly Rgba[]): boolean => {
  if (colour[3] === 0) {
    return true;
  }
  const tolerance = colour[3] >= 0.99 ? 2 : Math.ceil(2 / colour[3]) + 1;
  return palette.some((known) =>
    [0, 1, 2].every((at) => Math.abs((known[at] ?? 0) - (colour[at] ?? 0)) <= tolerance),
  );
};

const paintsOf = (
  element: Element,
  owners: ReadonlySet<Element>,
): { readonly what: string; readonly colour: string }[] => {
  const style = globalThis.getComputedStyle(element);
  const borders = ['top', 'right', 'bottom', 'left']
    .filter(
      (side) =>
        pixels(style.getPropertyValue(`border-${side}-width`)) > 0 &&
        style.getPropertyValue(`border-${side}-style`) !== 'none',
    )
    .map((side) => ({
      what: `border-${side}`,
      colour: style.getPropertyValue(`border-${side}-color`),
    }));
  const text = owners.has(element) ? [{ what: 'text', colour: style.color }] : [];
  const backdropped = element.matches(':modal')
    ? [
        {
          what: 'backdrop',
          colour: globalThis.getComputedStyle(element, '::backdrop').backgroundColor,
        },
      ]
    : [];
  return [
    { what: 'background', colour: style.backgroundColor },
    ...borders,
    ...text,
    ...backdropped,
  ];
};

/** The `data-palette` theme in force on an element, resolved from its parent's. */
const themeOf = (element: Element | null, themes: Map<Element, string>): string => {
  if (element === null) {
    return '';
  }
  const known = themes.get(element);
  if (known !== undefined) {
    return known;
  }
  const { HTMLElement, SVGElement, MathMLElement } = globalThis;
  const marked =
    element instanceof HTMLElement ||
    element instanceof SVGElement ||
    element instanceof MathMLElement
      ? element.dataset['palette']
      : undefined;
  const theme = marked ?? themeOf(element.parentElement, themes);
  themes.set(element, theme);
  return theme;
};

/** Every painted colour off the palette, or off the colour theme in force where it is painted.
 *  Each colour is read back once, and judged once per theme. */
const paletteIn = ({ scale, run }: { scale: Scale; run: string }): string[] => {
  const { colours, themes = {} } = scale;
  const seen = emptyMemo();
  const palette = colours.map((colour) => rgbaIn(colour, seen));
  const themed = new Map(
    Object.entries(themes).map(([id, own]) => [
      id,
      [...palette, ...own.map((one) => rgbaIn(one, seen))],
    ]),
  );
  const verdicts = new Map<string, boolean>();
  const owners = new Set<Element>(textOwners(seen, run));
  const scopes = new Map<Element, string>();
  const { body } = globalThis.document;
  return [body, ...body.querySelectorAll('*')]
    .filter(
      (element) =>
        element instanceof globalThis.HTMLElement &&
        !covered(element) &&
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    )
    .flatMap((element) => {
      const theme = themeOf(element, scopes);
      const allowed = themed.get(theme) ?? palette;
      return paintsOf(element, owners).flatMap(({ what, colour }) => {
        const read = rgbaIn(colour, seen);
        const key = `${theme}\u0000${colour}`;
        const fits = verdicts.get(key) ?? inPalette(read, allowed);
        verdicts.set(key, fits);
        return fits ? [] : [`${named(element)} ${what} ${hex(read)} is off the palette`];
      });
    });
};

/** The form controls the boundary rule measures. */
const CONTROLS =
  'input:not([type="hidden"]), select, textarea, [role="switch"], [role="checkbox"], [role="radio"]';

/** An element's own paints: its fill and each border side it draws. */
const ownPaints = (element: Element, seen: Memo): Rgba[] => {
  const style = globalThis.getComputedStyle(element);
  const sides = ['top', 'right', 'bottom', 'left']
    .filter(
      (side) =>
        pixels(style.getPropertyValue(`border-${side}-width`)) > 0 &&
        style.getPropertyValue(`border-${side}-style`) !== 'none',
    )
    .map((side) => rgbaIn(style.getPropertyValue(`border-${side}-color`), seen));
  return [rgbaIn(style.backgroundColor, seen), ...sides].filter((paint) => paint[3] > 0);
};

/** The nearest ancestor bordered on all four sides: a control's frame, if it is its own. */
const borderedAround = (element: Element): Element | undefined => {
  for (let around = element.parentElement; around !== null; around = around.parentElement) {
    const style = globalThis.getComputedStyle(around);
    const sides = ['top', 'right', 'bottom', 'left'].map((side) =>
      pixels(style.getPropertyValue(`border-${side}-width`)),
    );
    if (sides.every((width) => width > 0)) {
      return around;
    }
  }
  return undefined;
};

/** What draws a control's boundary (WCAG 1.4.11): its own fill or border, else its own frame. An
 *  unpainted option in a label is told apart by its text, so only its label counts, once chosen. */
const drawnBy = (
  control: Element,
  controls: readonly Element[],
  seen: Memo,
): Element | undefined => {
  if (ownPaints(control, seen).length > 0) {
    return control;
  }
  const label = control.closest('label');
  if (label !== null && control.matches('[type="radio"], [type="checkbox"]')) {
    return control.matches(':checked') && label.textContent.trim() !== '' ? label : undefined;
  }
  const frame = borderedAround(control);
  const own =
    frame !== undefined && controls.every((other) => other === control || !frame.contains(other));
  return own ? frame : control;
};

/** A native checkbox or radio's accent colour against what surrounds it, while it is chosen. */
const accentFindings = (control: Element, accent: string, seen: Memo): string[] => {
  const around = backdrop(control.parentElement, seen);
  if (accent === 'auto' || !control.matches(':checked') || around === undefined) {
    return [];
  }
  const found = contrastOf(over(rgbaIn(accent, seen), around), around);
  return found >= 3 ? [] : [`${named(control)} accent ${found.toFixed(2)}:1 < 3:1 (not held)`];
};

/** The best contrast of what draws a control's boundary against what surrounds it. */
const boundaryFindings = (control: Element, controls: readonly Element[], seen: Memo): string[] => {
  const bearer = drawnBy(control, controls, seen);
  const around = bearer === undefined ? undefined : backdrop(bearer.parentElement, seen);
  if (bearer === undefined || around === undefined) {
    return [];
  }
  const best = Math.max(
    1,
    ...ownPaints(bearer, seen).map((paint) => contrastOf(over(paint, around), around)),
  );
  const name = bearer.localName === 'label' ? named(bearer) : named(control);
  return best >= 3 ? [] : [`${name} boundary ${best.toFixed(2)}:1 < 3:1 (not held)`];
};

/** Form controls whose boundary is below 3:1 against what surrounds it. A native checkbox or radio
 *  is the platform's to draw (WCAG 1.4.11), bar the page's accent colour on a chosen one. */
const boundariesIn = (): string[] => {
  const seen = emptyMemo();
  const controls = [...globalThis.document.body.querySelectorAll(CONTROLS)].filter(
    (control) => control.checkVisibility({ visibilityProperty: true }) && !inactive(control),
  );
  return controls.flatMap((control) => {
    const style = globalThis.getComputedStyle(control);
    const native =
      control.matches('input[type="checkbox"], input[type="radio"]') && style.appearance !== 'none';
    return native
      ? accentFindings(control, style.accentColor, seen)
      : boundaryFindings(control, controls, seen);
  });
};

/** Faces only of the site's own font (--font-body, from kit's siteFont); text asks first for a
 *  generic family, a Tailwind default stack's first family, or the site's own. */
const fontsIn = ({ generic, run }: { generic: readonly string[]; run: string }): string[] => {
  const root = globalThis.getComputedStyle(globalThis.document.documentElement);
  const own = familiesOf(root.getPropertyValue(BODY_FONT));
  const allowed = new Set([
    ...generic,
    ...SYSTEM_STACKS.map((name) => firstFamily(root.getPropertyValue(name))),
    ...own.slice(0, 1),
  ]);
  const faces = [...globalThis.document.fonts]
    .map(({ family }) => firstFamily(family))
    .filter((family) => !own.includes(family))
    .map((family) => `the web font "${family}" is on the page, and not the site's own`);
  const asked = new Set(
    textOwners(emptyMemo(), run).map((owner) =>
      firstFamily(globalThis.getComputedStyle(owner).fontFamily),
    ),
  );
  const foreign = [...asked]
    .filter((family) => !allowed.has(family))
    .map((family) => `the font "${family}" is set on text, not a system stack or the site's own`);
  return [...new Set(faces), ...foreign];
};

/** The colour of an element's outline or box-shadow ring, if it draws one. */
const ringOf = (element: Element): string | undefined => {
  const style = globalThis.getComputedStyle(element);
  if (style.outlineStyle !== 'none' && pixels(style.outlineWidth) > 0) {
    return style.outlineColor;
  }
  const colours = style.boxShadow.match(
    /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)|#[\da-f]{3,8}/giu,
  );
  // A ring utility lists transparent shadows first: the drawn one is the ring.
  return (colours ?? []).find((colour) => rgba(colour)[3] > 0);
};

/** The control's own visible frame, while focus is within it. */
const frameOf = (element: Element): Element | undefined => {
  const frame = borderedAround(element);
  if (frame === undefined) {
    return undefined;
  }
  return frame.matches(':focus-within') ? frame : undefined;
};

/** The focused control's ring: its own, or (WCAG 2.4.7) its own frame's while focus is within,
 *  as an outline or a box shadow, at 3:1 against what surrounds it. */
const ringIn = (): string[] => {
  const focused = globalThis.document.activeElement;
  if (focused === null || !focused.matches(':focus-visible')) {
    return [];
  }
  const own = ringOf(focused);
  const frame = own === undefined ? frameOf(focused) : undefined;
  const [bearer, ring] = frame === undefined ? [focused, own] : [frame, ringOf(frame)];
  if (ring === undefined) {
    return [`${named(focused)} shows no focus ring`];
  }
  const around = backdrop(bearer.parentElement, emptyMemo());
  if (around === undefined) {
    return [];
  }
  const found = contrastOf(over(rgba(ring), around), around);
  return found >= 3 ? [] : [`${named(focused)} focus ring ${found.toFixed(2)}:1 < 3:1`];
};

/** CSS's generic families: text set in one uses the system's font for it. */
const GENERIC: readonly string[] =
  'serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong'.split(
    ' ',
  );

/** Tailwind's default font stacks, all system fonts. */
const SYSTEM_STACKS = ['--font-sans', '--font-serif', '--font-mono'];

const KIT = {
  covered,
  pixels,
  pen,
  rgba,
  hex,
  over,
  luminance,
  contrastOf,
  pageCanvas,
  emptyMemo,
  rgbaIn,
  backdrop,
  backdropOf,
  clippedAway,
  textOwners,
  findOwners,
  named,
  inactive,
  inPalette,
  paintsOf,
  themeOf,
  shownText,
  edgeText,
  boxesOf,
  edgesOfText,
  edgesOf,
  floated,
  mayGlue,
  touches,
  gluedPair,
  familiesOf,
  filesOf,
  firstFamily,
  ringOf,
  borderedAround,
  frameOf,
  ownPaints,
  drawnBy,
  accentFindings,
  boundaryFindings,
  CONTROLS,
  SYSTEM_STACKS,
  BODY_FONT,
};

export const designFindings = async (page: Page, scale: Scale): Promise<DesignFindings> => {
  const run = inPage(page, KIT);
  const call = randomUUID();
  await untilStill(page);
  const typography = await run(typographyIn, { text: scale.text, run: call });
  await untilStill(page);
  // Colours are judged at rest: with transitions off, each style reads as its end state, so a
  // control that starts one after the page came to rest (WebKit) is not caught midway.
  await page.evaluate(holdStill, true);
  try {
    return {
      typography,
      palette: await run(paletteIn, { scale, run: call }),
      glued: await run(gluedIn),
      fonts: await run(fontsIn, { generic: GENERIC, run: call }),
      flash: await run(flashIn),
      reported: await run(boundariesIn),
    };
  } finally {
    await page.evaluate(holdStill, false);
  }
};

export const focusRingOf = async (page: Page): Promise<string[]> => inPage(page, KIT)(ringIn);
