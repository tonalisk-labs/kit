// What each address of a build serves, the way its host serves it.
import path from 'node:path';

import type { SeoProfile } from '../adapter.ts';
import { keptOut } from '../checks/seo.ts';
import { factsOf, type Parsed, parseHtml } from './html.ts';
import { readSitemap } from './sitemap.ts';

export interface Page {
  readonly file: string;
  /** The 404 page answers at no address of its own. */
  readonly path: string | undefined;
  readonly parsed: Parsed;
}

export interface SiteBuild {
  readonly name: string;
  readonly origin: string;
  /** `file`: `a.html` is served at `/a` (Caddy's try_files). `directory`: `a/index.html` is
   *  served at `/a/`. */
  readonly style: 'file' | 'directory';
  readonly pages: readonly Page[];
  /** Every file by its path in the build, with its text only for the extensions in TEXT. */
  readonly files: ReadonlyMap<string, string | undefined>;
  readonly profile: SeoProfile;
}

export type Served =
  | { readonly kind: 'page'; readonly page: Page }
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'missing' };

export const TEXT = new Set(['.html', '.txt', '.xml', '.webmanifest']);
const HTML = '.html';
const INDEX = 'index.html';
const NOT_FOUND = '404.html';
const MISSING: Served = { kind: 'missing' };
const NO_PROFILE: SeoProfile = { noindex: [], disallow: [] };

const isIndex = (file: string): boolean => file === INDEX || file.endsWith(`/${INDEX}`);

/** `index.html` is `/`, `a/index.html` is `/a/` and `a.html` is `/a`. */
const addressOf = (file: string): string =>
  `/${file.slice(0, -(isIndex(file) ? INDEX : HTML).length)}`;

/** The sitemap index's first location, or else the home page's canonical. */
const originOf = (files: SiteBuild['files'], home: Parsed | undefined): string => {
  try {
    const [first] = readSitemap(files.get('sitemap-index.xml') ?? '').entries;
    if (first !== undefined) {
      return new URL(first.loc).origin;
    }
  } catch {
    // S05 reports an unreadable index.
  }
  const [href = ''] = home === undefined ? [] : factsOf(home).canonicals;
  return URL.canParse(href) ? new URL(href).origin : '';
};

export const siteOf = (
  name: string,
  files: SiteBuild['files'],
  profile: SeoProfile = NO_PROFILE,
): SiteBuild => {
  const pages = [...files]
    .filter(([file]) => file.endsWith(HTML))
    .map(([file, text = '']) => ({
      file,
      path: file === NOT_FOUND ? undefined : addressOf(file),
      parsed: parseHtml(text),
    }))
    .toSorted((left, right) => left.file.localeCompare(right.file));
  const home = pages.find(({ file }) => file === INDEX);
  const flat = pages.some(({ file }) => file !== NOT_FOUND && !isIndex(file));
  return {
    name,
    origin: originOf(files, home === undefined ? undefined : home.parsed),
    style: flat ? 'file' : 'directory',
    pages,
    files,
    profile,
  };
};

export const whereOf = (page: Page): string => page.path ?? page.file;

/** The 404 page's links resolve from `/`. */
export const urlOf = (site: SiteBuild, page: Page): URL =>
  new URL(page.path ?? '/', site.origin === '' ? 'https://invalid.example' : site.origin);

/** A profile pattern's `*` stands for one path segment. */
const matches = (address: string, pattern: string): boolean => {
  const [have, want] = [address.split('/'), pattern.split('/')];
  return (
    have.length === want.length &&
    want.every((part, at) => part === have[at] || (part === '*' && have[at] !== ''))
  );
};

/** The 404 page, and the pages the profile lists. */
export const meantNoindex = (site: SiteBuild, page: Page): boolean =>
  page.path === undefined ||
  site.profile.noindex.some((pattern) => matches(page.path ?? '', pattern));

export const indexable = (site: SiteBuild, page: Page): boolean =>
  !meantNoindex(site, page) && !keptOut(factsOf(page.parsed).robots);

const pageAt = (site: SiteBuild, file: string): Served => {
  const page = site.pages.find((candidate) => candidate.file === file);
  return page === undefined ? MISSING : { kind: 'page', page };
};

/** Caddy redirects `/a.html` and `/a/` to `/a`, `/index.html` to `/`, then tries `{path}.html`. */
const servedAsFiles = (site: SiteBuild, relative: string): Served => {
  if (relative === '') {
    return pageAt(site, INDEX);
  }
  if (relative.endsWith(HTML)) {
    return { kind: 'redirect', to: addressOf(relative) };
  }
  if (relative.endsWith('/')) {
    const bare = relative.slice(0, -1);
    return site.files.has(`${bare}${HTML}`) ? { kind: 'redirect', to: `/${bare}` } : MISSING;
  }
  return site.files.has(relative)
    ? { kind: 'file', file: relative }
    : pageAt(site, `${relative}${HTML}`);
};

/** GitHub Pages and CloudFront redirect `/a` and `/a/index.html` to `/a/`. */
const servedAsDirectories = (site: SiteBuild, relative: string): Served => {
  if (relative === '' || relative.endsWith('/')) {
    return pageAt(site, `${relative}${INDEX}`);
  }
  if (isIndex(relative)) {
    return { kind: 'redirect', to: addressOf(relative) };
  }
  if (site.files.has(relative)) {
    return { kind: 'file', file: relative };
  }
  return path.posix.extname(relative) === '' ? { kind: 'redirect', to: `/${relative}/` } : MISSING;
};

const decoded = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
};

export const served = (site: SiteBuild, pathname: string): Served => {
  const relative = decoded(pathname);
  if (relative === undefined) {
    return MISSING;
  }
  return site.style === 'file'
    ? servedAsFiles(site, relative.slice(1))
    : servedAsDirectories(site, relative.slice(1));
};
