import type { Page } from '@playwright/test';

import { inPage } from './in-page.ts';

/** The legibility floor every visible run of text is held to: CSS pixels and CSS weight. */
export const LEGIBILITY = { size: 12, weight: 400 } as const;

/** Elements whose own text is below the floor, as failure messages. Page-side functions here
 *  read only visible text nodes, and Playwright sends each source alone. */
export const illegibleText = (floor: {
  readonly size: number;
  readonly weight: number;
}): string[] => {
  const { document } = globalThis;
  const walker = document.createTreeWalker(document.body, globalThis.NodeFilter.SHOW_TEXT);
  const elements = new Set<HTMLElement>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      parent instanceof globalThis.HTMLElement &&
      (node.textContent ?? '').trim() !== '' &&
      parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      elements.add(parent);
    }
  }
  return [...elements].flatMap((element) => {
    const style = globalThis.getComputedStyle(element);
    const size = Number(style.fontSize.replace('px', ''));
    const weight = Number(style.fontWeight);
    if (size >= floor.size && weight >= floor.weight) {
      return [];
    }
    const text = element.textContent.trim().slice(0, 40);
    return [`<${element.localName}> "${text}" is ${String(size)}px at weight ${String(weight)}`];
  });
};

interface Edges {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** An ancestor that clips: its box, and its CSS `clip` and `clip-path` as computed. */
interface Clip extends Edges {
  readonly rect: string;
  readonly path: string;
}

export interface TextLine extends Edges {
  readonly clips: readonly Clip[];
  /** The owner's position among its ancestors' children, root first, joined by `/`. */
  readonly lineage: string;
  readonly text: string;
}

interface Traits {
  readonly clips: readonly Clip[];
  readonly lineage: string;
}

/** In the page: each element's clipping ancestors and lineage, built on its parent's and kept.
 *  Each parent's children are indexed once, when the first of them is asked for. */
const traitsMemo = (): ((element: Element) => Traits) => {
  const known = new Map<Element, Traits>();
  const positions = new Map<Element, number>();
  const positionOf = (parent: Element, element: Element): number => {
    if (!positions.has(element)) {
      for (const [at, child] of [...parent.children].entries()) {
        positions.set(child, at);
      }
    }
    return positions.get(element) ?? 0;
  };
  const traits = (element: Element): Traits => {
    const parent = element.parentElement;
    const inherited =
      parent === null ? { clips: [], lineage: '' } : (known.get(parent) ?? traits(parent));
    const style = globalThis.getComputedStyle(element);
    const overflow = `${style.overflowX} ${style.overflowY}` !== 'visible visible';
    const [rect, path] = [style.getPropertyValue('clip'), style.clipPath];
    const clipped = overflow || rect !== 'auto' || path !== 'none';
    const { left, top, right, bottom } = element.getBoundingClientRect();
    const index = parent === null ? 0 : positionOf(parent, element);
    const own = {
      clips: [...(clipped ? [{ left, top, right, bottom, rect, path }] : []), ...inherited.clips],
      lineage: `${inherited.lineage}/${String(index)}`,
    };
    known.set(element, own);
    return own;
  };
  return (element) => known.get(element) ?? traits(element);
};

/** In the page: the lines of every visible HTML text node with its clipping ancestors' boxes, so
 *  hidden text (a skip link at rest) is cut away before comparing. SVG text is left out. */
const textLinesIn = (): TextLine[] => {
  const { document } = globalThis;
  const traitsOf = traitsMemo();
  const walker = document.createTreeWalker(document.body, globalThis.NodeFilter.SHOW_TEXT);
  const lines: TextLine[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;
    const text = (node.textContent ?? '').trim().slice(0, 30);
    if (
      element instanceof globalThis.HTMLElement &&
      text !== '' &&
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    ) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const { clips, lineage } = traitsOf(element);
      for (const { left, top, right, bottom } of range.getClientRects()) {
        lines.push({ left, top, right, bottom, clips, lineage, text });
      }
    }
  }
  return lines;
};

/** The lines of every visible HTML text node on the page, as `textLinesIn` reads them. */
export const textLines = async (page: Page): Promise<TextLine[]> =>
  inPage(page, { traitsMemo })(textLinesIn);

type TextBox = Edges & Pick<TextLine, 'lineage' | 'text'>;

/** The area a clipping ancestor lets through: `clip: rect()` edges, or nothing for `inset(50%)`. */
const visibleArea = (clip: Clip): Edges => {
  const [inset = '0'] = clip.path.startsWith('inset(') ? clip.path.slice(6).split('%') : [];
  if (Number(inset) >= 50) {
    return { left: clip.left, top: clip.top, right: clip.left, bottom: clip.top };
  }
  const [top, right, bottom, left] = (clip.rect.startsWith('rect(') ? clip.rect.slice(5, -1) : '')
    .split(/[\s,]+/u)
    .map((edge) => (edge.endsWith('px') ? Number(edge.slice(0, -2)) : undefined));
  return {
    left: left === undefined ? clip.left : clip.left + left,
    top: top === undefined ? clip.top : clip.top + top,
    right: right === undefined ? clip.right : clip.left + right,
    bottom: bottom === undefined ? clip.bottom : clip.top + bottom,
  };
};

/** A line as drawn: cut to what every clipping ancestor lets through. */
const drawn = (line: TextLine): TextBox => {
  const box = { left: line.left, top: line.top, right: line.right, bottom: line.bottom };
  for (const clip of line.clips.map((ancestor) => visibleArea(ancestor))) {
    box.left = Math.max(box.left, clip.left);
    box.top = Math.max(box.top, clip.top);
    box.right = Math.min(box.right, clip.right);
    box.bottom = Math.min(box.bottom, clip.bottom);
  }
  return Object.assign(box, { lineage: line.lineage, text: line.text });
};

const area = (box: TextBox): number => (box.right - box.left) * (box.bottom - box.top);

const related = (one: TextBox, other: TextBox): boolean =>
  one.lineage === other.lineage ||
  one.lineage.startsWith(`${other.lineage}/`) ||
  other.lineage.startsWith(`${one.lineage}/`);

/** Whether two boxes share a fifth of the smaller one. */
const covers = (box: TextBox, other: TextBox): boolean => {
  const width = Math.min(other.right, box.right) - Math.max(other.left, box.left);
  const height = Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top);
  return width > 0 && height > 0 && width * height > Math.min(area(box), area(other)) / 5;
};

/** Lines of unrelated elements over each other by a fifth (`covers`), as adjacent blocks' line
 *  boxes may touch. Sorted by top, each box's scan ends at the first box starting below it. */
export const overlaps = (lines: readonly TextLine[]): string[] => {
  const boxes = lines
    .map((line) => drawn(line))
    .filter((box) => box.right - box.left > 1 && box.bottom - box.top > 1)
    .toSorted((one, other) => one.top - other.top);
  const found: string[] = [];
  for (const [index, box] of boxes.entries()) {
    for (let at = index + 1; at < boxes.length; at += 1) {
      const other = boxes[at];
      if (other === undefined || other.top >= box.bottom) {
        break;
      }
      if (!related(box, other) && covers(box, other)) {
        found.push(`"${box.text}" overlaps "${other.text}"`);
      }
    }
  }
  return found;
};
