// The page-side colour maths the design rules share: one colour over another, WCAG 2's contrast,
// and the colour behind an element. Each runs in the page with its rule's kit in scope (see
// design.ts).
import { type Memo, type Rgba, rgba, rgbaIn } from './paint.ts';

export const over = (top: Rgba, below: Rgba): Rgba => {
  const alpha = top[3] + below[3] * (1 - top[3]);
  const mix = (at: 0 | 1 | 2): number =>
    alpha === 0 ? 0 : (top[at] * top[3] + below[at] * below[3] * (1 - top[3])) / alpha;
  return [mix(0), mix(1), mix(2), alpha];
};

/** WCAG 2's relative luminance. */
export const luminance = (colour: Rgba): number => {
  const [red = 0, green = 0, blue = 0] = [colour[0], colour[1], colour[2]].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const contrastOf = (one: Rgba, other: Rgba): number => {
  const [light = 0, dark = 0] = [luminance(one), luminance(other)].toSorted(
    (first, second) => second - first,
  );
  return (light + 0.05) / (dark + 0.05);
};

/** The browser's canvas behind a page that paints none, as the system colour `Canvas` reads at
 *  the root: white or Chromium's dark grey by the page's scheme, or the forced palette's. */
export const pageCanvas = (): Rgba => {
  const { document } = globalThis;
  const probe = document.createElement('i');
  probe.hidden = true;
  probe.style.setProperty('background-color', 'Canvas');
  document.documentElement.append(probe);
  try {
    return rgba(globalThis.getComputedStyle(probe).backgroundColor);
  } finally {
    probe.remove();
  }
};

/** The colour behind an element: its and its ancestors' backgrounds, none past an image. */
export const backdrop = (element: Element | null, seen: Memo): Rgba | undefined => {
  if (element === null) {
    return pageCanvas();
  }
  if (!seen.backdrops.has(element)) {
    seen.backdrops.set(element, backdropOf(element, seen));
  }
  return seen.backdrops.get(element);
};

/** Memoised: a parent's backdrop is read once. */
export const backdropOf = (element: Element, seen: Memo): Rgba | undefined => {
  const style = globalThis.getComputedStyle(element);
  if (style.backgroundImage !== 'none') {
    return undefined;
  }
  const own = rgbaIn(style.backgroundColor, seen);
  if (own[3] >= 1) {
    return own;
  }
  const below = backdrop(element.parentElement, seen);
  return below === undefined ? undefined : over(own, below);
};
