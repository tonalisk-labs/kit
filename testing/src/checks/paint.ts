// The page-side primitives the design rules share: colours read back from a canvas, lengths,
// and one rule call's memo. Each runs in the page with its rule's kit in scope (see design.ts).

export type Rgba = readonly [number, number, number, number];

/** A 1×1 canvas kept on the page, where colours are painted to be read back. */
export const pen = (): CanvasRenderingContext2D => {
  const key = Symbol.for('sites.testing.pen');
  const held: unknown = Reflect.get(globalThis, key);
  if (held instanceof globalThis.CanvasRenderingContext2D) {
    return held;
  }
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const made = canvas.getContext('2d', { willReadFrequently: true });
  if (made === null) {
    throw new Error('the page has no 2D canvas to read colours with');
  }
  Object.defineProperty(globalThis, key, { value: made, configurable: true });
  return made;
};

/** A CSS colour as 8-bit sRGB channels and an alpha from 0 to 1. */
export const rgba = (colour: string): Rgba => {
  const context = pen();
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = '#000';
  context.fillStyle = colour;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue, alpha / 255];
};

/** A length in CSS pixels, as computed styles write it. */
export const pixels = (length: string): number => Number(length.replace(/px$/u, ''));

/** What gluing reads of a node's text: its first and last two code units (a whole code point at
 *  least), and whether it is all blank. */
export interface Edges {
  readonly head: string;
  readonly tail: string;
  readonly blank: boolean;
}

/** One rule call's answers per element and per colour: the page holds still while it runs. */
export interface Memo {
  readonly backdrops: Map<Element, Rgba | undefined>;
  readonly clipped: Map<Element, boolean>;
  readonly colours: Map<string, Rgba>;
  readonly edges: Map<Node, Edges>;
}

export const emptyMemo = (): Memo => ({
  backdrops: new Map(),
  clipped: new Map(),
  colours: new Map(),
  edges: new Map(),
});

/** `rgba`, read back once per colour string. */
export const rgbaIn = (colour: string, seen: Memo): Rgba => {
  const known = seen.colours.get(colour) ?? rgba(colour);
  seen.colours.set(colour, known);
  return known;
};

/** Whether an element is clipped to nothing, as screen-reader-only text is: a child is when its
 *  parent is, so each element is measured once per rule call. */
export const clippedAway = (element: Element | null, seen: Memo): boolean => {
  if (element === null || element === globalThis.document.body) {
    return false;
  }
  const known = seen.clipped.get(element);
  if (known !== undefined) {
    return known;
  }
  const { width, height } = element.getBoundingClientRect();
  const style = globalThis.getComputedStyle(element);
  const hidden =
    style.clipPath.startsWith('inset(50%') ||
    (width <= 1 && height <= 1 && style.overflow !== 'visible');
  const clipped = hidden || clippedAway(element.parentElement, seen);
  seen.clipped.set(element, clipped);
  return clipped;
};
