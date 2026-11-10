#!/usr/bin/env node
// Holds every site to default Tailwind as the kit theme's design system defines it: no arbitrary
// values, no names outside the theme, icons sized by name, no raw sizes or colours in CSS but the
// colours a site's @theme gives the semantic scales.
import { readFileSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { __unstable__loadDesignSystem } from '@tailwindcss/node';
import { parseSync, Visitor } from 'oxc-parser';

import { discover, REPO } from '../testing/src/discover.ts';
import { astroParts, blank, groupsOf, linesOf } from './source-text.ts';

type Category = 'arbitrary' | 'custom-token' | 'icon-size' | 'raw-css';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly category: Category;
  readonly text: string;
}

/** A file of a site, and the classes the site's own stylesheets define, which are classes as
 *  Tailwind's are. */
export interface SiteFile {
  readonly file: string;
  readonly own?: ReadonlySet<string>;
}

/** The folder kit is in, found the same from its sources, its build and an installed copy. */
const KIT = path.dirname(createRequire(import.meta.url).resolve('@tonalisk-labs/kit/package.json'));
const BASE = path.join(KIT, 'theme');
const CATEGORIES: readonly Category[] = ['arbitrary', 'custom-token', 'icon-size', 'raw-css'];
// The theme's three semantic scales, the one extension of the default theme (theme.css). A site's
// own @theme may give them colours of its own, such as its Apple app's accent and greys.
const SEMANTIC_TOKEN = /^--color-(?:primary|secondary|accent)-(?:50|[1-9]00|950)$/u;
// Any length but a hairline, a percentage or a viewport fraction other than vh.
const RAW_LENGTH = /(?<![\w-])\d*\.?\d+(?:px|rem|em|pt|pc|mm|cm|in|ch|ex|vh)\b/gu;
const RAW_COLOUR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/giu;
const QUOTED = /'(?<single>[^']*)'|"(?<double>[^"]*)"|`(?<back>[^`]*)`/gu;
// Classes with no CSS of their own, read by the group-* and peer-* variants: no candidate parses.
const MARKER = /^(?:group|peer)(?:\/[\w-]+)?$/u;
const NONE: ReadonlySet<string> = new Set();

const design = await __unstable__loadDesignSystem(
  readFileSync(path.join(BASE, 'index.css'), 'utf8'),
  {
    base: BASE,
  },
);

/** What is wrong with a word Tailwind reads as a class: brackets or parentheses make it
 *  arbitrary, and a utility that compiles to nothing names something outside the theme. */
const tokenProblem = (token: string, compiles: boolean): Category | undefined => {
  if (design.parseCandidate(token).length === 0) {
    return undefined;
  }
  if (token.includes('[') || token.includes('(')) {
    return 'arbitrary';
  }
  return compiles ? undefined : 'custom-token';
};

/** The findings in a string read as a class list, as every word is a class Tailwind or the site
 *  knows and one compiles; prose always has words that are neither, though some look like one. */
export const classFindings = (
  { file, own = NONE }: SiteFile,
  line: number,
  text: string,
): Finding[] => {
  const tokens = text.split(/\s+/u).filter((token) => token !== '');
  const isClass = (token: string): boolean =>
    MARKER.test(token) || own.has(token) || design.parseCandidate(token).length > 0;
  if (!tokens.every((token) => isClass(token))) {
    return [];
  }
  const compiles = design.candidatesToCss(tokens).map((css) => typeof css === 'string');
  if (!compiles.includes(true)) {
    return [];
  }
  return tokens.flatMap((token, at) => {
    const category = tokenProblem(token, compiles[at] === true);
    return category === undefined ? [] : [{ file, line, category, text: token }];
  });
};

/** Every string literal of a script, and each icon given a numeric size; `at` maps an offset to
 *  its line in the file. */
const scriptFindings = (site: SiteFile, source: string, at = linesOf(source)): Finding[] => {
  const { file } = site;
  const found: Finding[] = [];
  const { program } = parseSync(file.replace(/\.astro$/u, '.ts'), source);
  new Visitor({
    Literal: ({ start, value }): void => {
      if (typeof value === 'string') {
        found.push(...classFindings(site, at(start), value));
      }
    },
    TemplateElement: ({ start, value }): void => {
      found.push(...classFindings(site, at(start), value.cooked ?? value.raw));
    },
    JSXAttribute: ({ start, end, name, value }): void => {
      if (value === null || name.type !== 'JSXIdentifier' || name.name !== 'size') {
        return;
      }
      const { expression } =
        value.type === 'JSXExpressionContainer' ? value : { expression: value };
      if (expression.type === 'Literal' && typeof expression.value === 'number') {
        found.push({
          file,
          line: at(start),
          category: 'icon-size',
          text: source.slice(start, end),
        });
      }
    },
  }).visit(program);
  return found;
};

/** Blanks comments and the print-only blocks (@media print, @page), keeping line numbers. */
const blankUnchecked = (css: string): string => {
  const uncommented = css.replaceAll(/\/\*[\s\S]*?\*\//gu, blank);
  let out = uncommented;
  for (const match of uncommented.matchAll(/@(?:media\s+print|page)\b[^{]*\{/gu)) {
    let depth = 0;
    let end = uncommented.length;
    for (let at = match.index; at < uncommented.length && end === uncommented.length; at += 1) {
      const char = uncommented[at];
      depth += Number(char === '{') - Number(char === '}');
      if (char === '}' && depth === 0) {
        end = at + 1;
      }
    }
    out = out.slice(0, match.index) + blank(out.slice(match.index, end)) + out.slice(end);
  }
  return out;
};

/** Raw lengths, and raw colours but a semantic scale's own in @theme; theme names beyond the
 *  semantic scales; and each @apply's classes. */
export const cssFindings = (site: SiteFile, source: string, lineOffset = 0): Finding[] => {
  const { file } = site;
  const css = blankUnchecked(source);
  const lineOf = linesOf(css);
  const line = (offset: number): number => lineOffset + lineOf(offset);
  const raw = (match: RegExpExecArray): Finding => ({
    file,
    line: line(match.index),
    category: 'raw-css',
    text: match[0],
  });
  const declarations = [...css.matchAll(/@theme[^{]*\{[^}]*\}/gu)].flatMap((block) =>
    [...block[0].matchAll(/(?<name>--[\w-]+(?:-\*)?)\s*:(?<value>[^;}]*)/gu)].map((match) => {
      const start = block.index + match.index;
      const name = groupsOf(match)['name'] ?? '';
      return { name, start, end: start + match[0].length, semantic: SEMANTIC_TOKEN.test(name) };
    }),
  );
  const ownColour = (at: number): boolean =>
    declarations.some(({ start, end, semantic }) => semantic && at > start && at < end);
  const lengths = [...css.matchAll(RAW_LENGTH)]
    .filter(([whole]) => whole !== '1px')
    .map((match) => raw(match));
  const colours = [...css.matchAll(RAW_COLOUR)]
    .filter((match) => !ownColour(match.index))
    .map((match) => raw(match));
  const themes = declarations
    .filter(({ semantic }) => !semantic)
    .map(({ name, start }): Finding => ({
      file,
      line: line(start),
      category: 'custom-token',
      text: `${name}:`,
    }));
  const applies = [...css.matchAll(/@apply\s+(?<list>[^;]+);/gu)].flatMap((match) =>
    classFindings(site, line(match.index), groupsOf(match)['list'] ?? ''),
  );
  return [...lengths, ...colours, ...themes, ...applies];
};

/** The frontmatter as a script, and the template's class attributes as class lists. */
const astroFindings = (site: SiteFile, source: string): Finding[] => {
  const { frontmatter, template: base } = astroParts(source);
  const lineAt = linesOf(source);
  const script = scriptFindings(site, frontmatter, (start) => lineAt(4 + start));
  const template = source.slice(base);
  const attributes = template.matchAll(
    /\bclass(?::list)?=(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|\{(?<expression>[^}]*)\})/gu,
  );
  const classes = [...attributes].flatMap((match) => {
    const line = lineAt(base + match.index);
    const { double, single, expression = '' } = groupsOf(match);
    const literal = double ?? single;
    if (literal !== undefined) {
      return classFindings(site, line, literal);
    }
    return [...expression.matchAll(QUOTED)].flatMap((quoted) => {
      const { single: one, double: two, back } = groupsOf(quoted);
      return classFindings(site, line, one ?? two ?? back ?? '');
    });
  });
  const styles = [...template.matchAll(/<style[^>]*>(?<css>[\s\S]*?)<\/style>/gu)].flatMap(
    (match) => cssFindings(site, groupsOf(match)['css'] ?? '', lineAt(base + match.index) - 1),
  );
  return [...script, ...classes, ...styles];
};

/** The class names a stylesheet defines, as `.name` in its selectors. */
export const ownClasses = (css: string): string[] =>
  [...blankUnchecked(css).matchAll(/\.(?<name>-?[A-Za-z_][\w-]*)/gu)].map(
    (match) => groupsOf(match)['name'] ?? '',
  );

const findingsOf = async (site: SiteFile): Promise<Finding[]> => {
  const source = await readFile(path.join(REPO, site.file), 'utf8');
  if (site.file.endsWith('.css')) {
    return cssFindings(site, source);
  }
  return site.file.endsWith('.astro') ? astroFindings(site, source) : scriptFindings(site, source);
};

/** A site's scripts, pages and stylesheets under `root`, but dependencies, type declarations,
 *  generated files (`*.gen.ts`), and the theme stylesheets, whose colours are the theme data. */
export const sourcesOf = async (root: string, cwd = REPO): Promise<string[]> => {
  const files = await Array.fromAsync(
    glob(`${root}/**/*.{ts,tsx,astro,css}`, {
      cwd,
      exclude: ['**/node_modules/**', 'theme/themes/*.css', '**/*.d.ts', '**/*.gen.ts'],
    }),
  );
  return files.toSorted();
};

if (import.meta.main) {
  // Each site's sources in the repo under test; in kit itself, the theme.
  const sites =
    REPO === KIT
      ? [{ name: 'theme', root: 'theme' }]
      : discover().map(({ name, root }) => ({
          name,
          root: path.relative(REPO, path.join(root, 'src')),
        }));
  const results = await Promise.all(
    sites.map(async (site) => {
      const files = await sourcesOf(site.root);
      // A word the site's own stylesheets define is a class, as Tailwind's are.
      const sheets = files.filter((file) => file.endsWith('.css'));
      const css = await Promise.all(
        sheets.map(async (file) => readFile(path.join(REPO, file), 'utf8')),
      );
      const own = new Set(css.flatMap((sheet) => ownClasses(sheet)));
      const found = await Promise.all(files.map(async (file) => findingsOf({ file, own })));
      return { site, findings: found.flat() };
    }),
  );
  console.table(
    Object.fromEntries(
      results.map(({ site, findings }) => [
        site.name,
        Object.fromEntries(
          CATEGORIES.map((category) => [
            category,
            findings.filter((finding) => finding.category === category).length,
          ]),
        ),
      ]),
    ),
  );
  const failing = results.filter(({ findings }) => findings.length > 0);
  for (const { file, line, category, text } of failing.flatMap(({ findings }) => findings)) {
    console.log(`${file}:${String(line)}  ${category}  ${text}`);
  }
  if (failing.length > 0) {
    console.error(
      `lint-styles: ${failing.map(({ site }) => site.name).join(', ')} off default Tailwind`,
    );
    process.exitCode = 1;
  }
}
