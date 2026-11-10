// Page-side rule for words of neighbouring elements drawn with no space between; runs with the
// design rules' kit in scope (design.ts).

import { clippedAway, type Edges, emptyMemo, type Memo, pixels } from './paint.ts';

/** A text node whose words are shown: not blank, and not in a hidden or clipped element. */
export const shownText = (text: Node, seen: Memo): boolean => {
  const owner = text.parentElement;
  return (
    (text.textContent ?? '').trim() !== '' &&
    (owner === null ||
      (owner.checkVisibility({ visibilityProperty: true }) && !clippedAway(owner, seen)))
  );
};

/** A node's first or last shown text node: the walk stops at the first it meets from that end. */
export const edgeText = (node: ChildNode, last: boolean, seen: Memo): Node | undefined => {
  if (!(node instanceof globalThis.Element)) {
    return node;
  }
  const walker = globalThis.document.createTreeWalker(node, globalThis.NodeFilter.SHOW_TEXT);
  const step = (): Node | null => (last ? walker.previousNode() : walker.nextNode());
  for (let text = last ? walker.lastChild() : walker.nextNode(); text !== null; text = step()) {
    if (shownText(text, seen)) {
      return text;
    }
  }
  return undefined;
};

/** Where a node's first or last shown word is drawn: its text's line boxes (not the box of the
 *  element around it), cut to what its clipping ancestors leave visible, as a truncation does. */
export const boxesOf = (node: ChildNode, last: boolean, seen: Memo): DOMRect[] => {
  const text = edgeText(node, last, seen);
  if (text === undefined) {
    return [];
  }
  const range = globalThis.document.createRange();
  range.selectNodeContents(text);
  const clips: DOMRect[] = [];
  for (let around = text.parentElement; around !== null; around = around.parentElement) {
    if (globalThis.getComputedStyle(around).overflow !== 'visible') {
      clips.push(around.getBoundingClientRect());
    }
  }
  return [...range.getClientRects()].map((rect) => {
    const left = Math.max(rect.left, ...clips.map((clip) => clip.left));
    const right = Math.min(rect.right, ...clips.map((clip) => clip.right));
    return new globalThis.DOMRect(left, rect.top, Math.max(0, right - left), rect.height);
  });
};

export const edgesOfText = (text: string): Edges => ({
  head: text.slice(0, 2),
  tail: text.slice(-2),
  blank: text.trim() === '',
});

/** A node's `Edges`, an element's from its children's (as its text is theirs), each once. */
export const edgesOf = (node: Node, known: Map<Node, Edges>): Edges => {
  const cached = known.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const { Element, Node: Kind } = globalThis;
  let found = edgesOfText(node instanceof Element ? '' : (node.textContent ?? ''));
  if (node instanceof Element) {
    for (const child of node.childNodes) {
      const text = child.nodeType === Kind.TEXT_NODE || child.nodeType === Kind.CDATA_SECTION_NODE;
      if (text || child instanceof Element) {
        const part = edgesOf(child, known);
        found = {
          head: (found.head + part.head).slice(0, 2),
          tail: (found.tail + part.tail).slice(-2),
          blank: found.blank && part.blank,
        };
      }
    }
  }
  known.set(node, found);
  return found;
};

/** Drawn out of the flow its neighbours share: a fixed or absolute box, a modal, a popover. */
export const floated = (node: ChildNode): boolean =>
  node instanceof globalThis.Element &&
  (node.matches('dialog, [popover]') ||
    ['fixed', 'absolute'].includes(globalThis.getComputedStyle(node).position));

/** Neighbours a word runs across, unless both are text or either floats. Adjacent text nodes draw
 *  as one run (an editor splits long lines), so only a pair with an element can glue. */
export const mayGlue = (before: ChildNode, next: ChildNode, seen: Memo): boolean =>
  (before instanceof globalThis.Element || next instanceof globalThis.Element) &&
  /[\p{L}\p{N}]$/u.test(edgesOf(before, seen.edges).tail) &&
  /^[\p{L}\p{N}]/u.test(edgesOf(next, seen.edges).head) &&
  !floated(before) &&
  !floated(next);

/** Box `start` begins on the line box `end` closes, to its right and under 0.15em from it. */
export const touches = (end: DOMRect, start: DOMRect, parent: Element): boolean =>
  Math.min(end.bottom, start.bottom) - Math.max(end.top, start.top) >
    Math.min(end.height, start.height) / 2 &&
  start.left > end.left &&
  start.left - end.right < pixels(globalThis.getComputedStyle(parent).fontSize) * 0.15;

/** Two neighbours whose words touch on one line, their characters checked before their boxes. */
export const gluedPair = (
  { before, next, parent }: { before: ChildNode; next: ChildNode; parent: Element },
  seen: Memo,
): string[] => {
  if (!mayGlue(before, next, seen)) {
    return [];
  }
  const [end, start] = [boxesOf(before, true, seen).at(-1), boxesOf(next, false, seen).at(0)];
  if (start === undefined || end === undefined || !touches(end, start, parent)) {
    return [];
  }
  const gap = start.left - end.right;
  const [left, right] = [(before.textContent ?? '').trim(), (next.textContent ?? '').trim()];
  return [`"${left.slice(-20)}" runs into "${right.slice(0, 20)}" (${gap.toFixed(1)}px apart)`];
};

export const gluedIn = (): string[] => {
  const seen = emptyMemo();
  return [...globalThis.document.body.querySelectorAll('*')].flatMap((parent) => {
    const children = [...parent.childNodes].filter(
      (child) =>
        !edgesOf(child, seen.edges).blank &&
        (!(child instanceof globalThis.Element) ||
          child.checkVisibility({ visibilityProperty: true })),
    );
    return children.slice(1).flatMap((next, at) => {
      const before = children[at];
      return before === undefined ? [] : gluedPair({ before, next, parent }, seen);
    });
  });
};
