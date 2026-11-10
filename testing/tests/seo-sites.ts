// A small built site whose every page passes, in either URL style: a test changes one thing.
import type { SeoProfile } from '../src/adapter.ts';
import { type Finding, staticFindings } from '../src/checks/seo-static.ts';
import { type SiteBuild, siteOf } from '../src/seo/build.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
export const DIRECTORY = 'https://www.example.com';
export const FILE = 'https://www.example.org';
export const DATED = ['2026-10-01T10:00:00Z', '2026-10-02T10:00:00+01:00'] as const;

/** A page's parts; any left out takes the value that passes. */
export interface PageParts {
  readonly title?: string;
  readonly description?: string;
  readonly lang?: string;
  readonly head?: string;
  readonly body?: string;
  readonly noindex?: boolean;
  readonly canonical?: string;
  readonly data?: readonly object[];
}

type Files = Readonly<Record<string, string | undefined>>;

export const titleAt = (path: string): string => `A page at ${path} of the example site`;

export const descriptionAt = (path: string): string =>
  `What the page at ${path} holds, said in a sentence of a fair length.`;

const metaOf = (url: string, words: { title: string; description: string }): string =>
  [
    `<title>${words.title}</title>`,
    `<meta name="description" content="${words.description}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:locale" content="en_GB">',
    `<meta property="og:title" content="${words.title}">`,
    `<meta property="og:description" content="${words.description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${new URL('/card.png', url).href}">`,
    '<meta property="og:image:alt" content="The card">',
  ].join('');

/** The site, the page unless it is kept out of the index, and `data`. */
const graphOf = (url: string, title: string, parts: PageParts): string => {
  const home = new URL('/', url).href;
  const site = { '@type': 'WebSite', '@id': `${home}#site`, name: 'Example', url: home };
  const own = { '@type': 'WebPage', '@id': url, url, name: title };
  const nodes = [site, ...(parts.noindex === true ? [] : [own]), ...(parts.data ?? [])];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes });
};

export const page = (origin: string, path: string, parts: PageParts = {}): string => {
  const url = `${origin}${path}`;
  const title = parts.title ?? titleAt(path);
  const words = { title, description: parts.description ?? descriptionAt(path) };
  const robots =
    parts.noindex === true
      ? '<meta name="robots" content="noindex">'
      : `<link rel="canonical" href="${parts.canonical ?? url}">`;
  const head = `<meta charset="utf-8">${robots}${metaOf(url, words)}`;
  const data = `<script type="application/ld+json">${graphOf(url, title, parts)}</script>`;
  const body = `<main><h1>${title}</h1>${parts.body ?? '<p><a href="/">Home</a></p>'}</main>`;
  const lang = parts.lang ?? 'en-GB';
  return `<!doctype html><html lang="${lang}"><head>${head}${data}${parts.head ?? ''}</head><body>${body}</body></html>`;
};

export const sitemap = (
  root: 'urlset' | 'sitemapindex',
  entries: readonly (readonly [string, string | undefined])[],
): string => {
  const item = root === 'urlset' ? 'url' : 'sitemap';
  const listed = entries.map(([loc, lastmod]) => {
    const dated = lastmod === undefined ? '' : `<lastmod>${lastmod}</lastmod>`;
    return `<${item}><loc>${loc}</loc>${dated}</${item}>`;
  });
  const namespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${namespace}">${listed.join('')}</${root}>`;
};

/** Home, `other` at `path`, the 404 page, robots.txt, the sitemaps and the card. */
const files = (origin: string, other: string, path: string): Map<string, string | undefined> => {
  const lost = page(origin, '/404', { title: 'Page not found on the example site', noindex: true });
  const listed = sitemap('urlset', [
    [`${origin}/`, DATED[0]],
    [`${origin}${path}`, DATED[1]],
  ]);
  return new Map([
    ['index.html', page(origin, '/')],
    [other, page(origin, path)],
    ['404.html', lost],
    ['robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap-index.xml\n`],
    ['sitemap-index.xml', sitemap('sitemapindex', [[`${origin}/sitemap-0.xml`, undefined]])],
    ['sitemap-0.xml', listed],
    ['card.png', undefined],
  ]);
};

/** Served at `/about/`. */
export const directorySite = (changes: Files = {}, profile?: SeoProfile): SiteBuild =>
  siteOf(
    'example.com',
    new Map([...files(DIRECTORY, 'about/index.html', '/about/'), ...Object.entries(changes)]),
    profile,
  );

/** Served at `/about`. */
export const fileSite = (changes: Files = {}, profile?: SeoProfile): SiteBuild =>
  siteOf(
    'example.org',
    new Map([...files(FILE, 'about.html', '/about'), ...Object.entries(changes)]),
    profile,
  );

const findingsOn = (sites: readonly SiteBuild[]): Finding[] =>
  [...staticFindings(sites, NOW).values()].flat();

/** As `rule severity where: message`. */
export const report = (...sites: SiteBuild[]): string[] =>
  findingsOn(sites).map(
    ({ rule, severity, where, message }) => `${rule} ${severity} ${where}: ${message}`,
  );

/** As `rule severity where`, each once, sorted. */
export const rulesOf = (...sites: SiteBuild[]): string[] =>
  [
    ...new Set(
      findingsOn(sites).map(({ rule, severity, where }) => `${rule} ${severity} ${where}`),
    ),
  ].toSorted();
