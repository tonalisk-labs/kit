// A built page parsed once by parse5, as a browser parses it: a template's content is left out.
import { type DefaultTreeAdapterTypes, html, parse } from 'parse5';

import type { SeoFacts } from '../checks/seo.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export interface Parsed {
  readonly elements: readonly Element[];
}

/** HTML's ASCII whitespace besides the space: what separates `rel` tokens and a title's words. */
const SPACES = ['\t', '\n', '\f', '\r'];

const childrenOf = (node: Node): readonly Node[] => ('childNodes' in node ? node.childNodes : []);

export const parseHtml = (source: string): Parsed => {
  const elements: Element[] = [];
  const visit = (node: Node): void => {
    for (const child of childrenOf(node)) {
      if ('tagName' in child) {
        elements.push(child);
        visit(child);
      }
    }
  };
  visit(parse(source));
  return { elements };
};

export const attribute = (element: Element, name: string): string | undefined => {
  const found = element.attrs.find((attr) => attr.name === name);
  return found === undefined ? undefined : found.value;
};

export const textOf = (node: Node): string =>
  'value' in node
    ? node.value
    : childrenOf(node)
        .map((child) => textOf(child))
        .join('');

const wordsOf = (text: string): string[] => {
  let spaced = text;
  for (const space of SPACES) {
    spaced = spaced.replaceAll(space, ' ');
  }
  return spaced.split(' ').filter((word) => word !== '');
};

/** Whitespace collapsed and trimmed, as `document.title` reads a title. */
export const plain = (text: string): string => wordsOf(text).join(' ');

/** HTML elements only: an SVG's `title` is not the page's. */
export const named = (parsed: Parsed, name: string): Element[] =>
  parsed.elements.filter(
    (element) => element.tagName === name && element.namespaceURI === html.NS.HTML,
  );

/** The contents of the metas whose `name` or `property` is `key`. */
export const metaContents = (parsed: Parsed, key: string): string[] =>
  named(parsed, 'meta')
    .filter((meta) => attribute(meta, 'name') === key || attribute(meta, 'property') === key)
    .map((meta) => attribute(meta, 'content') ?? '');

export const linked = (parsed: Parsed, rel: string): string[] =>
  named(parsed, 'link')
    .filter((link) => wordsOf((attribute(link, 'rel') ?? '').toLowerCase()).includes(rel))
    .map((link) => attribute(link, 'href') ?? '');

/** What the e2e sweep's `seoFacts` reads in the browser. */
export const factsOf = (parsed: Parsed): SeoFacts => {
  const [root] = named(parsed, 'html');
  return {
    lang: root === undefined ? '' : (attribute(root, 'lang') ?? ''),
    canonicals: linked(parsed, 'canonical'),
    robots: [...metaContents(parsed, 'robots'), ...metaContents(parsed, 'googlebot')].join(','),
    descriptions: metaContents(parsed, 'description'),
    headings: named(parsed, 'h1').map((heading) => textOf(heading)),
    data: named(parsed, 'script')
      .filter((script) => attribute(script, 'type') === 'application/ld+json')
      .map((script) => textOf(script)),
  };
};
