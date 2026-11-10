import type { Page } from '@playwright/test';

import { inPage } from './in-page.ts';
import { untilStill } from './still.ts';

/** What can take focus from the keyboard, before tabindex, disabled and visibility are weighed. */
const FOCUSABLE =
  'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';

const KEY = 'sites.testing.keyboard';

/** How many times round the page's tab order the walk goes before it gives up. */
const LAPS = 2;

/** The most stops one element takes: a native media control's (play, timeline, volume…). */
const STOPS_PER_CONTROL = 8;

/* Page-side functions run alone or through `inPage` with `KIT` in scope, as Playwright sends a
 *  function's source alone. */

/** In the tab order: its tabIndex not negative, and enabled, not inert and visible. */
const inTabOrder = (element: Element): element is HTMLElement =>
  element instanceof globalThis.HTMLElement &&
  element.tabIndex >= 0 &&
  !element.matches(':disabled') &&
  element.closest('[inert]') === null &&
  element.checkVisibility({ visibilityProperty: true });

interface Walk {
  readonly members: ReadonlySet<Element>;
  readonly reached: Set<Element>;
  first: Element | null | undefined;
  last: Element | null | undefined;
  held: number;
  laps: number;
  presses: number;
  done: boolean;
  ended: boolean;
}

/** Notes one Tab's stop: a lap is a return to the first stop, and a walk ends after `laps` of them
 *  or once one control holds focus past `stops` presses. */
const noteStop = (walk: Walk, { laps, stops }: { laps: number; stops: number }): void => {
  const focused = globalThis.document.activeElement;
  const held = focused === walk.last ? walk.held + 1 : 1;
  const lapped = walk.first !== undefined && focused === walk.first && held === 1;
  walk.first ??= focused;
  walk.last = focused;
  walk.held = held;
  walk.laps += lapped ? 1 : 0;
  walk.presses += 1;
  if (focused !== null && walk.members.has(focused)) {
    walk.reached.add(focused);
  }
  walk.done = walk.reached.size === walk.members.size;
  walk.ended = walk.laps >= laps || held > stops;
};

interface Marking {
  readonly key: string;
  readonly selector: string;
  readonly laps: number;
  readonly stops: number;
}

/** Records the controls in <main>; answers their count and the page's. Each Tab notes its control;
 *  a walk ends `laps` times back on its first stop, or past `stops` (Firefox holds the last). */
const markControls = ({ key, selector, laps, stops }: Marking): readonly [number, number] => {
  const { document } = globalThis;
  const tabbable = [...document.querySelectorAll(selector)].filter((element) =>
    inTabOrder(element),
  );
  const main = document.querySelector('main');
  const controls = main === null ? [] : tabbable.filter((element) => main.contains(element));
  const state = {
    controls,
    members: new Set(controls),
    reached: new Set<Element>(),
    first: undefined as Element | null | undefined,
    last: undefined as Element | null | undefined,
    held: 0,
    laps: 0,
    presses: 0,
    done: false,
    ended: false,
    note: (event?: KeyboardEvent): void => {
      if (event === undefined || event.key === 'Tab') {
        noteStop(state, { laps, stops });
      }
    },
    stop: (): void => {
      globalThis.removeEventListener('keyup', state.note, { capture: true });
    },
  };
  globalThis.addEventListener('keyup', state.note, { capture: true });
  Object.defineProperty(globalThis, Symbol.for(key), { value: state, configurable: true });
  return [main === null ? -1 : controls.length, tabbable.length];
};

/** Moves the tab order's start to the document's top, whatever the page focused on load: Firefox
 *  never wraps past the last control, so controls before an autofocused one would go unreached. */
const startAtTop = (): void => {
  const { document } = globalThis;
  const start = document.createElement('span');
  start.tabIndex = -1;
  document.body.prepend(start);
  start.focus({ preventScroll: true });
  start.blur();
  start.remove();
};

/** The walk after press `count` (noted, all reached, ended), noting a press held unseen in native
 *  media controls; a walk whose page lost its state (a navigation) has ended, presses unknown. */
const walkOf = ({
  key,
  count,
}: {
  readonly key: string;
  readonly count: number;
}): readonly [number, boolean, boolean] => {
  const state: unknown = Reflect.get(globalThis, Symbol.for(key));
  if (typeof state !== 'object' || state === null) {
    return [Number.NaN, false, true];
  }
  // Chromium tells the page of no key while Tab moves among a media element's native controls:
  // the element keeps focus, not :focus, and holds the press.
  const focused = globalThis.document.activeElement;
  const note: unknown = Reflect.get(state, 'note');
  if (
    Number(Reflect.get(state, 'presses')) === count - 1 &&
    focused instanceof globalThis.HTMLMediaElement &&
    focused.controls &&
    !focused.matches(':focus') &&
    typeof note === 'function'
  ) {
    Reflect.apply(note, undefined, []);
  }
  return [
    Number(Reflect.get(state, 'presses')),
    Reflect.get(state, 'done') === true,
    Reflect.get(state, 'ended') === true,
  ];
};

/** The controls never reached, by tag and text. The walk stops noting. */
const unreachedControls = (key: string): string[] => {
  const state: unknown = Reflect.get(globalThis, Symbol.for(key));
  const controls: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'controls') : [];
  const reached: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'reached') : undefined;
  const stop: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'stop') : undefined;
  if (typeof stop === 'function') {
    Reflect.apply(stop, undefined, []);
  }
  if (!Array.isArray(controls) || !(reached instanceof Set)) {
    return ['the keyboard check lost its state'];
  }
  return controls
    .filter((control: unknown) => control instanceof globalThis.Element && !reached.has(control))
    .map(
      (control: Element) =>
        `<${control.localName}> "${control.textContent.trim().slice(0, 40)}" is not reached by Tab`,
    );
};

interface Pressing {
  readonly key: string;
  readonly minimum: number;
  readonly limit: number;
  readonly count: number;
}

/** Presses, reading the walk after each, until `minimum` presses were made and every control was
 *  reached or the walk ended, or the limit, which only a focus trap reaches. */
const pressUntil = async (page: Page, pressing: Pressing): Promise<number> => {
  await page.keyboard.press(pressing.key);
  const count = pressing.count + 1;
  const [noted, done, ended] = await page.evaluate(walkOf, { key: KEY, count });
  if (!Number.isNaN(noted) && noted !== count) {
    throw new Error(`the keyboard walk noted ${String(noted)} of ${String(count)} presses`);
  }
  if (((done || ended) && count >= pressing.minimum) || count >= pressing.limit) {
    return count;
  }
  return pressUntil(page, {
    key: pressing.key,
    minimum: pressing.minimum,
    limit: pressing.limit,
    count,
  });
};

export interface Reach {
  readonly presses: number;
  readonly unreached: readonly string[];
}

/** Tabs until every control in <main> has had focus, at least `minimum` times (each press is one
 *  INP interaction), and at most twice round the tab order. */
export const tabThrough = async (page: Page, key: string, minimum: number): Promise<Reach> => {
  await page.evaluate(startAtTop);
  const [controls, total] = await inPage(page, KIT)(markControls, {
    key: KEY,
    selector: FOCUSABLE,
    laps: LAPS,
    stops: STOPS_PER_CONTROL,
  });
  if (controls < 0) {
    return { presses: 0, unreached: ['the page has no <main> landmark'] };
  }
  const presses = await pressUntil(page, {
    key,
    minimum,
    limit: Math.max(minimum, LAPS * STOPS_PER_CONTROL * (total + 1)),
    count: 0,
  });
  return { presses, unreached: await page.evaluate(unreachedControls, KEY) };
};

/** Whether a control shows itself once focused. WebKit reveals a focused control only after
 *  focus() returns, so the reveal is made here before looking. */
const shownWhenFocused = (element: HTMLElement): boolean => {
  element.focus();
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  const onScreen =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < globalThis.innerHeight &&
    rect.left < globalThis.innerWidth;
  return (
    rect.width > 1 &&
    rect.height > 1 &&
    onScreen &&
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  );
};

/** A control named by its text, else its label or title. A frame is also named by where its
 *  document came from, which says whose it is. */
const focusableName = (element: Element): string => {
  const text = element.textContent.trim();
  const label = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '';
  const frame =
    element instanceof globalThis.HTMLIFrameElement && /^https?:/u.test(element.src)
      ? new URL(element.src)
      : undefined;
  const source = frame === undefined ? '' : ` from ${frame.origin}${frame.pathname}`;
  return `<${element.localName}> "${(text === '' ? label : text).slice(0, 40)}"${source}`;
};

/** The helpers the page-side functions here name. */
const KIT = { inTabOrder, noteStop, shownWhenFocused, focusableName };

/** Focuses each control in turn, bar those `exempt` matches, and answers those then out of
 *  sight. */
const invisibleWhenFocused = ({
  selector,
  exempt,
}: {
  readonly selector: string;
  readonly exempt?: string | undefined;
}): string[] => {
  const { document } = globalThis;
  const hidden = [...document.querySelectorAll(selector)].filter(
    (element) =>
      inTabOrder(element) &&
      (exempt === undefined || !element.matches(exempt)) &&
      !shownWhenFocused(element),
  );
  if (document.activeElement instanceof globalThis.HTMLElement) {
    document.activeElement.blur();
  }
  return hidden.map((element) => `${focusableName(element)} takes focus but cannot be seen`);
};

/** Every control that takes focus without showing itself, bar those `exempt` matches, as failure
 *  messages; judged at rest, as a dialog still fading in shows its controls a moment later. */
export const invisibleFocusables = async (page: Page, exempt?: string): Promise<string[]> => {
  await untilStill(page);
  return inPage(page, KIT)(invisibleWhenFocused, { selector: FOCUSABLE, exempt });
};

const RINGS = 'sites.testing.rings';

/** The most controls whose rings one screen measures: a modal's, or the page's first. */
const MOST_RINGS = 60;

/** Remembers what has focus and the controls a keyboard reaches in the topmost modal (or the
 *  page when none is open); answers how many there are. */
const markRingControls = ({
  key,
  selector,
  most,
}: {
  readonly key: string;
  readonly selector: string;
  readonly most: number;
}): number => {
  const { document } = globalThis;
  const modals = [...document.querySelectorAll('dialog')].filter((dialog) =>
    dialog.matches(':modal'),
  );
  const scope = modals.at(-1) ?? document.body;
  const controls = [...scope.querySelectorAll(selector)]
    .filter((element) => inTabOrder(element))
    .slice(0, most);
  const state = { controls, focused: document.activeElement };
  Object.defineProperty(globalThis, Symbol.for(key), { value: state, configurable: true });
  return controls.length;
};

/** Focuses the control at `at` from script, without scrolling to it, and waits out whatever
 *  its focus sets moving: a ring that fades in (a colour transition) is measured once drawn. */
const focusMarked = async ({
  key,
  at,
}: {
  readonly key: string;
  readonly at: number;
}): Promise<void> => {
  const state: unknown = Reflect.get(globalThis, Symbol.for(key));
  const controls: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'controls') : [];
  const control: unknown = Array.isArray(controls) ? controls[at] : undefined;
  if (!(control instanceof globalThis.HTMLElement)) {
    return;
  }
  control.focus({ preventScroll: true });
  await Promise.all(
    control.getAnimations().map(async (animation) =>
      animation.finished.catch((error: unknown) => {
        // A transition cut short rejects its promise: it has ended all the same.
        if (!(error instanceof globalThis.DOMException && error.name === 'AbortError')) {
          throw error;
        }
      }),
    ),
  );
};

const refocus = (key: string): void => {
  const state: unknown = Reflect.get(globalThis, Symbol.for(key));
  const focused: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'focused') : undefined;
  if (focused instanceof globalThis.HTMLElement) {
    focused.focus({ preventScroll: true });
  }
};

/** Each keyboard-reachable control focused in turn, its ring measured by `ringOf`. One Tab first
 *  sets keyboard mode so a scripted focus shows `:focus-visible`; focus is restored after. */
export const focusRings = async (
  page: Page,
  ringOf: (page: Page) => Promise<string[]>,
): Promise<string[]> => {
  const count = await inPage(page, KIT)(markRingControls, {
    key: RINGS,
    selector: FOCUSABLE,
    most: MOST_RINGS,
  });
  await page.keyboard.press('Tab');
  const measure = async (at: number, found: readonly string[]): Promise<readonly string[]> => {
    if (at >= count) {
      return found;
    }
    await page.evaluate(focusMarked, { key: RINGS, at });
    return measure(at + 1, [...found, ...(await ringOf(page))]);
  };
  const found = await measure(0, []);
  await page.evaluate(refocus, RINGS);
  return [...new Set(found)];
};
