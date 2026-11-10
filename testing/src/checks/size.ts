// What each built page makes a visitor download, as brotli bytes: the scripts it runs before it is
// usable (its eager graph) and its stylesheets; and, across the site, the chunks it loads later
// and its wasm. The rules do no I/O: a build is read into a map of its files first.
import { brotliCompressSync, constants } from 'node:zlib';

import { attribute, linked, named, parseHtml } from '../seo/html.ts';

/** What a page or a site is held to, in brotli bytes. */
export interface SizeBudget {
  /** Each page's eager scripts: its module scripts, preloads, eager islands and their imports. */
  readonly eager: number;
  /** Each page's stylesheets. */
  readonly css: number;
  /** The site's scripts that load later: dynamic imports, workers and islands that wait. */
  readonly lazy: number;
  /** The site's WebAssembly. */
  readonly wasm: number;
}

/** A build, by path from its root (`_astro/x.js`): each file's bytes. */
export type Build = ReadonlyMap<string, Uint8Array>;

interface PageSize {
  readonly page: string;
  readonly eager: number;
  readonly css: number;
}

export interface SiteSize {
  readonly pages: readonly PageSize[];
  readonly lazy: number;
  readonly wasm: number;
}

/** An import a chunk makes as it runs: `import x from "./a.js"`, `import "./a.js"`, `export … from`. */
const STATIC_IMPORT =
  /(?:\bimport|\bexport)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](?<path>[^"']+\.m?js)["']/gu;

/** A chunk loaded later: `import("./a.js")`, or in backticks, as Vite writes it. */
const DYNAMIC_IMPORT = /\bimport\(\s*(?<quote>["'`])(?<path>[^"'`]+\.m?js)\k<quote>\s*\)/gu;

/** Any other asset a chunk names, a worker's script or wasm among them: `"./a.wasm"`, or in
 *  backticks. */
const NAMED_ASSET =
  /(?<quote>["'`])(?<path>(?:\.{1,2}\/|\/)[^"'`\s]+\.(?:m?js|wasm|css))\k<quote>/gu;

/** Islands that hydrate as the page loads; the others wait to be seen, idle or matched. */
const EAGER_ISLANDS = new Set(['load', 'only']);

const decoder = new TextDecoder();

/** `reference` from the file at `from` as a path in the build, or nothing when it leaves the site. */
const resolve = (reference: string, from: string): string | undefined => {
  const url = URL.parse(reference, new URL(from, 'https://site/'));
  if (url === null) {
    return undefined;
  }
  return url.origin === 'https://site' ? url.pathname.slice(1) : undefined;
};

const matchesIn = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap(({ groups = {} }) => {
    const { path } = groups;
    return path === undefined ? [] : [path];
  });

/** What a chunk imports at once, and what it names for later. */
const referencesOf = (build: Build, file: string): { now: string[]; later: string[] } => {
  const bytes = build.get(file);
  if (bytes === undefined || !/\.m?js$/u.test(file)) {
    return { now: [], later: [] };
  }
  const text = decoder.decode(bytes);
  const inBuild = (references: readonly string[]): string[] =>
    references.flatMap((reference) => {
      const resolved = resolve(reference, file);
      return resolved === undefined || !build.has(resolved) ? [] : [resolved];
    });
  const now = inBuild(matchesIn(text, STATIC_IMPORT));
  const eager = new Set(now);
  const later = inBuild([...matchesIn(text, DYNAMIC_IMPORT), ...matchesIn(text, NAMED_ASSET)]);
  return { now, later: later.filter((found) => !eager.has(found) && found !== file) };
};

/** Everything `roots` import at once, transitively, and what that names for later. */
const graphOf = (
  build: Build,
  roots: readonly string[],
): { eager: Set<string>; later: Set<string> } => {
  const eager = new Set<string>();
  const later = new Set<string>();
  const queue = [...roots];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!eager.has(file)) {
      eager.add(file);
      const { now, later: forLater } = referencesOf(build, file);
      queue.push(...now);
      for (const found of forLater) {
        later.add(found);
      }
    }
  }
  for (const file of eager) {
    later.delete(file);
  }
  return { eager, later };
};

/** Everything `roots` reach, eagerly or later, transitively. */
const reachOf = (build: Build, roots: Iterable<string>): Set<string> => {
  const reached = new Set<string>();
  const queue = [...roots];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (!reached.has(file)) {
      reached.add(file);
      const { now, later } = referencesOf(build, file);
      queue.push(...now, ...later);
    }
  }
  return reached;
};

/** A page's entry points: those it runs as it loads, and those it leaves for later. */
const entriesOf = (
  html: string,
  page: string,
  build: Build,
): { now: string[]; later: string[]; css: string[] } => {
  const parsed = parseHtml(html);
  const inBuild = (references: readonly string[]): string[] =>
    references.flatMap((reference) => {
      const resolved = resolve(reference, page);
      return resolved === undefined || !build.has(resolved) ? [] : [resolved];
    });
  const scripts = named(parsed, 'script').flatMap((script) => {
    const src = attribute(script, 'src');
    return src === undefined ? [] : [src];
  });
  const inline = named(parsed, 'script')
    .filter((script) => attribute(script, 'src') === undefined)
    .flatMap((script) =>
      script.childNodes.flatMap((child) =>
        'value' in child ? matchesIn(child.value, STATIC_IMPORT) : [],
      ),
    );
  const islands = named(parsed, 'astro-island').map((island) => ({
    eager: EAGER_ISLANDS.has(attribute(island, 'client') ?? ''),
    urls: [attribute(island, 'component-url'), attribute(island, 'renderer-url')].flatMap((url) =>
      url === undefined ? [] : [url],
    ),
  }));
  return {
    now: inBuild([
      ...scripts,
      ...inline,
      ...linked(parsed, 'modulepreload'),
      ...islands.filter(({ eager }) => eager).flatMap(({ urls }) => urls),
    ]),
    later: inBuild(islands.filter(({ eager }) => !eager).flatMap(({ urls }) => urls)),
    css: inBuild(linked(parsed, 'stylesheet')),
  };
};

/** Brotli at its highest quality, as a host precompresses or a CDN serves static files. */
const brotliOf = (bytes: Uint8Array): number =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength;

/** Astro's scoped style names: a component outside the Astro root (in a hoisted node_modules) is
 *  named by its absolute path, so each checkout's stylesheets compress a few dozen bytes apart. */
const SCOPED = /\b(?<kind>astro|data-astro-cid)-(?<hash>[a-z0-9]{8})\b/gu;

const encoder = new TextEncoder();

/** A stylesheet as any checkout builds it: each scoped name numbered by where it first appears,
 *  so names stay as distinct as they were, and the size is the same from any path. */
export const pathFree = (css: string): string => {
  const numbers = new Map<string, string>();
  return css.replaceAll(SCOPED, (_whole, kind: string, hash: string) => {
    const known = numbers.get(hash) ?? String(numbers.size).padStart(8, '0');
    numbers.set(hash, known);
    return `${kind}-${known}`;
  });
};

/** A file name with a content hash, as Vite names chunks and assets (`app.Dqn7M9-M.js`) and a
 *  worker's script (`scan-worker-BskI6fuR.js`). */
const HASHED = /^(?<stem>[\w.-]+)(?<separator>[.-])(?<hash>[\w-]{8})(?<extension>\.[a-z0-9]+)$/u;

/** The content-hashed names of a build's files, longest first, as its files name one another;
 *  nothing when it has none. */
export const hashedNames = (build: Build): RegExp | undefined => {
  const names = [...build.keys()]
    .map((file) => file.slice(file.lastIndexOf('/') + 1))
    .filter((name) => HASHED.test(name))
    .toSorted((one, other) => other.length - one.length);
  return names.length === 0
    ? undefined
    : new RegExp(names.map((name) => name.replaceAll('.', String.raw`\.`)).join('|'), 'gu');
};

/** A file with each of the build's hashed `names` numbered by where it first appears: a change to
 *  one chunk renames every chunk that imports it, moving their size by tens of bytes. */
export const hashFree = (text: string, names?: RegExp): string => {
  if (names === undefined) {
    return text;
  }
  const numbers = new Map<string, string>();
  return text.replaceAll(names, (name) => {
    const match = HASHED.exec(name);
    if (match === null) {
      return name;
    }
    const { groups = {} } = match;
    const { stem = '', separator = '', extension = '' } = groups;
    const known = numbers.get(name) ?? String(numbers.size).padStart(8, '0');
    numbers.set(name, known);
    return `${stem}${separator}${known}${extension}`;
  });
};

/** What a file weighs: a script or stylesheet with the build's hashed names numbered, and a
 *  stylesheet without its path-named classes; anything else as built. */
const weighed = (file: string, bytes: Uint8Array, names: RegExp | undefined): Uint8Array => {
  if (!/\.(?:m?js|css)$/u.test(file)) {
    return bytes;
  }
  const text = hashFree(decoder.decode(bytes), names);
  return encoder.encode(file.endsWith('.css') ? pathFree(text) : text);
};

/** Every page's eager scripts and stylesheets, and the site's later scripts and wasm. */
export const sizeOf = (build: Build): SiteSize => {
  const names = hashedNames(build);
  const compressed = new Map<string, number>();
  const bytesOf = (file: string): number => {
    const known = compressed.get(file);
    if (known !== undefined) {
      return known;
    }
    const size = brotliOf(weighed(file, build.get(file) ?? new Uint8Array(), names));
    compressed.set(file, size);
    return size;
  };
  const total = (files: Iterable<string>): number =>
    [...files].reduce((sum, file) => sum + bytesOf(file), 0);
  const pages = [...build.keys()].filter((file) => file.endsWith('.html')).toSorted();
  const eagerAnywhere = new Set<string>();
  const laterRoots = new Set<string>();
  const sized = pages.map((page) => {
    const entries = entriesOf(decoder.decode(build.get(page)), page, build);
    const { eager, later } = graphOf(build, entries.now);
    for (const file of eager) {
      eagerAnywhere.add(file);
    }
    for (const file of [...later, ...entries.later]) {
      laterRoots.add(file);
    }
    return { page, eager: total(eager), css: total(entries.css) };
  });
  const reached = [...reachOf(build, laterRoots)].filter((file) => !eagerAnywhere.has(file));
  return {
    pages: sized,
    lazy: total(reached.filter((file) => /\.m?js$/u.test(file))),
    wasm: total([...build.keys()].filter((file) => file.endsWith('.wasm'))),
  };
};

/** What is over its budget, as lines a person reads. */
export const overBudget = (size: SiteSize, budget: SizeBudget): string[] => [
  ...size.pages.flatMap(({ page, eager, css }) => [
    ...(eager > budget.eager
      ? [`${page}: eager scripts ${String(eager)} B, over ${String(budget.eager)} B`]
      : []),
    ...(css > budget.css
      ? [`${page}: stylesheets ${String(css)} B, over ${String(budget.css)} B`]
      : []),
  ]),
  ...(size.lazy > budget.lazy
    ? [`later scripts ${String(size.lazy)} B, over ${String(budget.lazy)} B`]
    : []),
  ...(size.wasm > budget.wasm
    ? [`wasm ${String(size.wasm)} B, over ${String(budget.wasm)} B`]
    : []),
];
