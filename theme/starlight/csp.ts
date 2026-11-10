// The CSP of a Starlight site. Astro hashes only what it bundles: Starlight's is:inline scripts,
// its style attributes and the inlined engravings' <style> elements and attributes are hashed here.
import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AstroUserConfig } from 'astro';

type Csp = Exclude<NonNullable<AstroUserConfig['security']>['csp'], boolean | undefined>;
type Hash = `sha256-${string}`;

const sha256 = (text: string): Hash =>
  `sha256-${createHash('sha256').update(text).digest('base64')}`;

interface Found {
  readonly pattern: RegExp;
  readonly seen: Set<string>;
  readonly bodies: string[];
}

/** Adds to `bodies`, in order, each text `pattern`'s one group finds in `text` not yet seen. */
const addBodies = (text: string, { pattern, seen, bodies }: Found): void => {
  for (const [, body = ''] of text.matchAll(pattern)) {
    if (!seen.has(body)) {
      seen.add(body);
      bodies.push(body);
    }
  }
};

/** Per pattern, the distinct texts its one group finds in the files `glob` matches in `dir`. */
const bodiesIn = (dir: string, glob: string, patterns: readonly RegExp[]): string[][] => {
  const found = patterns.map((pattern): Found => ({
    pattern,
    seen: new Set<string>(),
    bodies: [],
  }));
  for (const file of globSync(glob, { cwd: dir })) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const entry of found) {
      addBodies(text, entry);
    }
  }
  return found.map(({ bodies }) => bodies);
};

/** Starlight's components folder, resolved on use: a site without Starlight still loads kit/astro. */
const starlightDir = (): string =>
  path.dirname(createRequire(import.meta.url).resolve('@astrojs/starlight/components/Head.astro'));
const ENGRAVINGS = '{scores,figures}/**/*.svg';
const starlightStyles = (depths: number): string[] => [
  'display: none;',
  'padding:0',
  '--sl-select-width: 6.25em',
  // The colour theme's select (./theme-select.astro).
  '--sl-select-width: 9em',
  ...[...Array.from({ length: depths }).keys()].map((depth) => `--depth: ${String(depth)};`),
  ...['1em', '1rem', '1.25rem', '1.333em', '1.5rem'].map((size) => `--sl-icon-size: ${size};`),
];

interface Options {
  /** The public dir whose SVGs under scores/ and figures/ the pages inline. */
  readonly engravings?: URL;
  /** Starlight's own setting, whose heading levels set the nesting depths; else top level only. */
  readonly tableOfContents?: { readonly minHeadingLevel: number; readonly maxHeadingLevel: number };
  /** The origins a page may frame, in place of the site's own. */
  readonly frames?: readonly string[];
}

export const starlightCsp = ({ engravings, tableOfContents, frames }: Options = {}): Csp => {
  const depths =
    tableOfContents === undefined
      ? 1
      : tableOfContents.maxHeadingLevel - tableOfContents.minHeadingLevel + 1;
  const dir = engravings === undefined ? undefined : fileURLToPath(engravings);
  const [scriptBodies = []] = bodiesIn(starlightDir(), '*.astro', [
    /<script is:inline[^>]*>(?<body>[\s\S]*?)<\/script>/gu,
  ]);
  const scripts = scriptBodies.map((body) => sha256(body));
  // One read of each engraving serves both its <style> elements and its style attributes.
  const [styleBodies = [], styleAttributes = []] =
    dir === undefined
      ? []
      : bodiesIn(dir, ENGRAVINGS, [
          /<style[^>]*>(?<body>[\s\S]*?)<\/style>/gu,
          /\sstyle="(?<body>[^"]*)"/gu,
        ]);
  // Inside an inline SVG, a CDATA section's markers are not part of the element's text.
  const styles = styleBodies.map((body) =>
    sha256(body.replaceAll(/<!\[CDATA\[(?<text>[\s\S]*?)\]\]>/gu, '$<text>')),
  );
  const attributes = [...new Set([...starlightStyles(depths), ...styleAttributes])].map(
    (value) => ({ hash: sha256(value), kind: 'attribute' as const }),
  );
  return {
    directives: [
      "default-src 'self'",
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      ...(frames === undefined ? [] : [`frame-src ${frames.join(' ')}` as const]),
    ],
    scriptDirective: { hashes: scripts },
    styleDirective: {
      resources: [{ resource: "'unsafe-hashes'", kind: 'attribute' }],
      hashes: [...styles, ...attributes],
    },
  };
};
