import type { Page } from '@playwright/test';

import { type Helper, inPage } from './in-page.ts';
import { OVERLAY_KIT, shownWhole } from './overlays.ts';

/** Where a target's notices sit: centred, at the bottom, or at the top on a short screen. */
export interface Toasts {
  /** The notices themselves, each one box. */
  readonly selector: string;
  /** At this viewport height or less, the notices sit at the top. */
  readonly topUpTo: number;
}

export interface LayoutOptions {
  /** Hold every control to a 44 × 44 target: the touch rows, 9-16. */
  readonly touch: boolean;
  readonly toasts: Toasts | undefined;
}

export interface LayoutFindings {
  readonly modals: readonly string[];
  /** An open dialog or popover not shown whole: too small, see-through, or its heading hidden. */
  readonly overlays: readonly string[];
  readonly toasts: readonly string[];
  readonly overflow: readonly string[];
  readonly clipped: readonly string[];
  readonly overlap: readonly string[];
  /** A notice that hides the focused control entirely (WCAG 2.2 SC 2.4.11). */
  readonly obscured: readonly string[];
  readonly targets: readonly string[];
}

/** Every element's box, by its position among its ancestors, for two themes to compare. */
export type Geometry = Readonly<Record<string, string>>;

/* Page-side functions run through `inPage` with this kit in scope. A control counts only when it
 *  is topmost at its own centre, so what a modal's backdrop covers or a drawer hides is out. */

const CONTROLS =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"], [role="slider"]';

/** An element as a failure message names it: its tag and its text or label. Its text is read
 *  node by node only until 40 characters past the leading space are known, not in full. */
const describe = (element: Element): string => {
  const walker = globalThis.document.createTreeWalker(element, globalThis.NodeFilter.SHOW_TEXT);
  let read = '';
  let folded = '';
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    read += node.nodeValue ?? '';
    folded = read.trimStart().replaceAll(/\s+/gu, ' ');
    if (/\S/u.test(folded.slice(40))) {
      break;
    }
  }
  const text = folded.trimEnd().slice(0, 40);
  return `<${element.localName}> "${text === '' ? (element.getAttribute('aria-label') ?? '') : text}"`;
};

const edges = (rect: DOMRect): string =>
  [rect.left, rect.top, rect.width, rect.height].map((edge) => edge.toFixed(1)).join(', ');

/** The controls a person can press now: visible, and topmost at their centre. */
const pressable = (selector: string): Element[] =>
  [...globalThis.document.querySelectorAll(selector)].filter((control) => {
    if (!control.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
    const rect = control.getBoundingClientRect();
    const hit = globalThis.document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return rect.width > 1 && rect.height > 1 && hit !== null && control.contains(hit);
  });

interface Touched {
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
}

/** The viewport's edges a box reaches, to within half a pixel. */
const edgesTouched = (rect: DOMRect): Touched => ({
  left: rect.left <= 0.5,
  right: rect.right >= globalThis.innerWidth - 0.5,
  top: rect.top <= 0.5,
  bottom: rect.bottom >= globalThis.innerHeight - 0.5,
});

/** A modal against no edge sits centred, though one of the viewport's full height may scroll. */
const centring = (dialog: Element, rect: DOMRect): string[] => {
  const [width, height] = [globalThis.innerWidth, globalThis.innerHeight];
  const offX = Math.abs(rect.left + rect.width / 2 - width / 2);
  const offY = Math.abs(rect.top + rect.height / 2 - height / 2);
  return offX <= 1 && (offY <= 1 || rect.height >= height - 1)
    ? []
    : [`${describe(dialog)} is off centre by ${offX.toFixed(1)}, ${offY.toFixed(1)} px`];
};

/** A modal is centred on both axes; one against an edge is a drawer, spanning that edge. */
const modalIn = (dialog: Element): string[] => {
  const rect = dialog.getBoundingClientRect();
  const touches = edgesTouched(rect);
  if (touches.left !== touches.right) {
    return touches.top && touches.bottom
      ? []
      : [`${describe(dialog)} is a side drawer not pinned top to bottom (${edges(rect)})`];
  }
  if (touches.bottom && !touches.top) {
    return touches.left && touches.right
      ? []
      : [`${describe(dialog)} is a bottom sheet not pinned side to side (${edges(rect)})`];
  }
  return centring(dialog, rect);
};

const modalsIn = (): string[] =>
  [...globalThis.document.querySelectorAll('dialog')]
    .filter((dialog) => dialog.matches(':modal'))
    .flatMap((dialog) => modalIn(dialog));

const overlaysIn = (): string[] =>
  [...new Set(globalThis.document.querySelectorAll('dialog[open], :popover-open'))].flatMap(
    (overlay) => shownWhole(overlay),
  );

/** Notices sit centred, whole on screen, at the bottom, or at the top on a short screen. */
const toastsIn = (toasts: Toasts): string[] => {
  const [width, height] = [globalThis.innerWidth, globalThis.innerHeight];
  const top = height <= toasts.topUpTo;
  return [...globalThis.document.querySelectorAll(toasts.selector)]
    .filter((toast) => toast.checkVisibility({ visibilityProperty: true }))
    .flatMap((toast) => {
      const rect = toast.getBoundingClientRect();
      const centred = Math.abs(rect.left + rect.width / 2 - width / 2) <= 1;
      const whole = rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height;
      const placed = top ? rect.top < height / 2 : rect.bottom > height / 2;
      return centred && whole && placed
        ? []
        : [
            `${describe(toast)} sits at ${edges(rect)}, not centred ${top ? 'at the top' : 'at the bottom'}`,
          ];
    });
};

/** The page, and each open modal, fit their width: nothing scrolls sideways. */
const overflowIn = (): string[] => {
  const { documentElement } = globalThis.document;
  const page =
    documentElement.scrollWidth > documentElement.clientWidth + 0.5
      ? [
          `the page scrolls sideways by ${String(documentElement.scrollWidth - documentElement.clientWidth)}px`,
        ]
      : [];
  const modals = [...globalThis.document.querySelectorAll('dialog')]
    .filter((dialog) => dialog.matches(':modal') && dialog.scrollWidth > dialog.clientWidth + 0.5)
    .map((dialog) => `${describe(dialog)} scrolls sideways`);
  return [...page, ...modals];
};

const hidesOverflow = (overflow: string): boolean => overflow === 'hidden' || overflow === 'clip';

/** A box that hides overflow it has, with no ellipsis or line clamp to say so. */
const cutsOff = (element: Element, style: CSSStyleDeclaration): boolean => {
  const across =
    hidesOverflow(style.overflowX) &&
    element.scrollWidth > element.clientWidth + 1 &&
    style.textOverflow !== 'ellipsis';
  const down =
    hidesOverflow(style.overflowY) &&
    element.scrollHeight > element.clientHeight + 1 &&
    style.getPropertyValue('-webkit-line-clamp') === 'none';
  return across || down;
};

/** Text cut off by a box that hides its overflow, with no ellipsis or line clamp to say so. */
const clippedIn = (): string[] =>
  [...globalThis.document.body.querySelectorAll('*')].flatMap((element) => {
    const style = globalThis.getComputedStyle(element);
    // Only a box that cuts something off has its text read: most cut nothing.
    const seen =
      cutsOff(element, style) &&
      element.clientWidth > 1 &&
      element.clientHeight > 1 &&
      !style.clipPath.startsWith('inset(50%') &&
      element.textContent.trim() !== '' &&
      element.checkVisibility({ visibilityProperty: true });
    return seen ? [`${describe(element)} cuts off its content`] : [];
  });

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A measure of the part of an element its scrolling or clipping ancestors leave drawn. Each
 *  ancestor's clip is its parent's cut by its own box, read once per measure. */
const shownBoxes = (): ((element: Element) => Edges) => {
  const clips = new Map<Element, Edges>();
  const cut = (outer: Edges, box: Edges): Edges => ({
    left: Math.max(outer.left, box.left),
    top: Math.max(outer.top, box.top),
    right: Math.min(outer.right, box.right),
    bottom: Math.min(outer.bottom, box.bottom),
  });
  const clipOf = (element: Element | null): Edges => {
    if (element === null) {
      const { NEGATIVE_INFINITY: low, POSITIVE_INFINITY: high } = Number;
      return { left: low, top: low, right: high, bottom: high };
    }
    const known = clips.get(element);
    if (known !== undefined) {
      return known;
    }
    const outer = clipOf(element.parentElement);
    const clipping = globalThis.getComputedStyle(element).overflow !== 'visible';
    const clip = clipping ? cut(outer, element.getBoundingClientRect()) : outer;
    clips.set(element, clip);
    return clip;
  };
  return (element) => cut(clipOf(element.parentElement), element.getBoundingClientRect());
};

/** Two controls drawn over each other, neither inside the other; a passing notice may cover a
 *  control (the focus rule holds it). One sweep down the page pairs only boxes whose rows meet. */
const overlapIn = ({ selector, notices }: { selector: string; notices: string }): string[] => {
  const shown = shownBoxes();
  const items = pressable(selector)
    .filter((control) => notices === '' || control.closest(notices) === null)
    .map((control, at) => ({ control, at, box: shown(control) }));
  const byTop = items.toSorted((one, two) => one.box.top - two.box.top);
  const pairs: { one: (typeof items)[number]; two: (typeof items)[number] }[] = [];
  for (const [rank, one] of byTop.entries()) {
    for (let next = rank + 1; next < byTop.length; next += 1) {
      const two = byTop[next];
      if (two === undefined || two.box.top >= one.box.bottom - 0.5) {
        break;
      }
      const width = Math.min(one.box.right, two.box.right) - Math.max(one.box.left, two.box.left);
      const height = Math.min(one.box.bottom, two.box.bottom) - two.box.top;
      if (width > 0.5 && height > 0.5) {
        pairs.push(one.at < two.at ? { one, two } : { one: two, two: one });
      }
    }
  }
  return pairs
    .toSorted((left, right) => left.one.at - right.one.at || left.two.at - right.two.at)
    .filter(
      ({ one, two }) => !one.control.contains(two.control) && !two.control.contains(one.control),
    )
    .map(({ one, two }) => `${describe(one.control)} overlaps ${describe(two.control)}`);
};

/** The focused control hidden entirely by a notice: no point of it the notices leave in view. */
const obscuredIn = (notices: string): string[] => {
  const focused = globalThis.document.activeElement;
  if (focused === null || focused === globalThis.document.body || notices === '') {
    return [];
  }
  const box = shownBoxes()(focused);
  const [width, height] = [box.right - box.left, box.bottom - box.top];
  if (width <= 0 || height <= 0) {
    return [];
  }
  const probes = [0.1, 0.5, 0.9].flatMap((across) =>
    [0.1, 0.5, 0.9].map((down) => [box.left + width * across, box.top + height * down] as const),
  );
  const hits = probes.map(([left, top]) => globalThis.document.elementFromPoint(left, top));
  const covered = hits.every((hit) => hit !== null && hit.closest(notices) !== null);
  return covered ? [`${describe(focused)} is hidden behind a notice while focused`] : [];
};

/** A link inside a sentence is exempt, as WCAG's target size allows. */
const inSentence = (control: Element): boolean =>
  control.localName === 'a' &&
  globalThis.getComputedStyle(control).display === 'inline' &&
  (control.parentElement === null ? 0 : control.parentElement.textContent.trim().length) >
    control.textContent.trim().length;

/** A control whose press area, its hit test included, is smaller than `minimum` square. */
const targetsIn = ({ selector, minimum }: { selector: string; minimum: number }): string[] =>
  pressable(selector)
    .filter((control) => !inSentence(control))
    .flatMap((control) => {
      const rect = control.getBoundingClientRect();
      // Engines lay boxes out in 1/60 or 1/64 px units: a 44 px box may measure a unit short.
      const fits = minimum - 1 / 32;
      if (rect.width >= fits && rect.height >= fits) {
        return [];
      }
      const [centreX, centreY] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
      const reach = minimum / 2 - 1;
      const probes = [-reach, 0, reach].flatMap((across) =>
        [-reach, 0, reach].map((down) => [centreX + across, centreY + down] as const),
      );
      const inside = probes.filter(
        ([left, top]) =>
          left >= 0 && top >= 0 && left < globalThis.innerWidth && top < globalThis.innerHeight,
      );
      const missed = inside.some(([left, top]) => {
        const hit = globalThis.document.elementFromPoint(left, top);
        return hit === null || !control.contains(hit);
      });
      return missed
        ? [
            `${describe(control)} is ${rect.width.toFixed(1)} × ${rect.height.toFixed(1)}, under ${String(minimum)} × ${String(minimum)}`,
          ]
        : [];
    });

/** Each visible element's box but the notices' (they come and go), keyed by child positions from
 *  <body>: on the page, so a scroll between looks moves none, a fixed box's in the viewport. */
const geometryIn = (notices: string): Record<string, string> => {
  const boxes: Record<string, string> = {};
  const { scrollX, scrollY } = globalThis;
  const visit = (element: Element, path: string, pinned: boolean): void => {
    if (
      !element.checkVisibility({ visibilityProperty: true }) ||
      (notices !== '' && element.matches(notices))
    ) {
      return;
    }
    const fixed = pinned || globalThis.getComputedStyle(element).position === 'fixed';
    const rect = element.getBoundingClientRect();
    const placed = fixed
      ? rect
      : new globalThis.DOMRect(rect.x + scrollX, rect.y + scrollY, rect.width, rect.height);
    boxes[`${path} ${describe(element)}`] = edges(placed);
    for (const [at, child] of [...element.children].entries()) {
      visit(child, `${path}/${String(at)}`, fixed);
    }
  };
  visit(globalThis.document.body, '', false);
  return boxes;
};

const LAYOUT_KIT: Record<string, Helper> = {
  describe,
  edges,
  pressable,
  edgesTouched,
  centring,
  modalIn,
  inSentence,
  hidesOverflow,
  cutsOff,
  shownBoxes,
};
const KIT = Object.assign(LAYOUT_KIT, OVERLAY_KIT);

/** WCAG 2.5.5's target size, held on a touch row. */
const TARGET_PX = 44;

export const layoutFindings = async (
  page: Page,
  options: LayoutOptions,
): Promise<LayoutFindings> => {
  const run = inPage(page, KIT);
  const notices = options.toasts === undefined ? '' : options.toasts.selector;
  return {
    modals: await run(modalsIn),
    overlays: await run(overlaysIn),
    toasts: options.toasts === undefined ? [] : await run(toastsIn, options.toasts),
    overflow: await run(overflowIn),
    clipped: await run(clippedIn),
    overlap: await run(overlapIn, { selector: CONTROLS, notices }),
    obscured: await run(obscuredIn, notices),
    targets: options.touch ? await run(targetsIn, { selector: CONTROLS, minimum: TARGET_PX }) : [],
  };
};

export const geometryOf = async (page: Page, notices = ''): Promise<Geometry> =>
  inPage(page, KIT)(geometryIn, notices);

/** Boxes that moved or resized between two looks at a page, such as its two themes, which should
 *  change colours alone; `names` say which look is which. */
export const parity = (
  one: Geometry,
  other: Geometry,
  names: readonly [string, string] = ['in light', 'in dark'],
): string[] =>
  Object.entries(one).flatMap(([key, box]) => {
    const then = other[key];
    return then === undefined || then === box
      ? []
      : [`${key}: ${box} ${names[0]}, ${then} ${names[1]}`];
  });
