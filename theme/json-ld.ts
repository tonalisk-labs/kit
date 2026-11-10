import type { Graph } from 'schema-dts';

/** A JSON-LD script as a Starlight head entry. Spelled out rather than taken from Starlight, whose
 *  types reach Node's through Astro's: a site's browser code imports this module too. */
export interface JsonLdHead {
  readonly tag: 'script';
  readonly attrs: { readonly type: 'application/ld+json' };
  readonly content: string;
}

/** `value` as script text; `<` becomes \u003c, so nothing inside can close or alter the element. */
export const jsonLdScript = (value: Graph): string =>
  JSON.stringify(value).replaceAll('<', String.raw`\u003c`);

/** `value` as a Starlight head entry. */
export const jsonLdHead = (value: Graph): JsonLdHead => ({
  tag: 'script',
  attrs: { type: 'application/ld+json' },
  content: jsonLdScript(value),
});
