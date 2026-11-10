import path from 'node:path';

import robotsParser from 'robots-parser';

import { isObject, type JsonObject } from '../unknown.ts';
import {
  indexable,
  meantNoindex,
  type Page,
  type Served,
  served,
  type SiteBuild,
  urlOf,
  whereOf,
} from './build.ts';
import { failing, type Finding, findings, warning } from './finding.ts';
import { attribute, linked, named } from './html.ts';
import { blocksOf, idOf, listOf, objectsIn, pageNodes, textAt, typesOf } from './json-ld.ts';
import { W3C_DATETIME } from './shapes.ts';
import { readSitemap, SITEMAP_NAMESPACE, type SitemapEntry } from './sitemap.ts';

const ROBOTS = 'robots.txt';
const INDEX = 'sitemap-index.xml';
const CRAWLERS = ['Googlebot', 'Bingbot', '*'];
/** Every page answers these without an element of the id: none, and Starlight's top. */
const BUILT_IN_FRAGMENTS = new Set(['', '_top']);
/** The data's properties whose value is an address. */
const LINKING = ['url', 'item', 'thumbnailUrl', 'logo', 'image'];
/** A build must not publish a README, a source map or a source; a licence's Markdown is meant. */
const SOURCES = new Set(['.map', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.astro', '.mdx']);

const hostOf = (site: SiteBuild): string =>
  URL.canParse(site.origin) ? new URL(site.origin).host : '';

const siteAt = (sites: readonly SiteBuild[], href: string): SiteBuild | undefined => {
  const origin = URL.canParse(href) ? new URL(href).origin : '';
  return sites.find((site) => site.origin === origin);
};

const failure = (href: string, answer: Served): string[] => {
  if (answer.kind === 'redirect') {
    return [`${href} redirects to ${answer.to}`];
  }
  return answer.kind === 'missing' ? [`${href} leads nowhere`] : [];
};

const idsOf = (page: Page): Set<string> =>
  new Set(
    page.parsed.elements.flatMap((element) =>
      [
        attribute(element, 'id'),
        element.tagName === 'a' ? attribute(element, 'name') : undefined,
      ].filter((id) => id !== undefined),
    ),
  );

const fragmentOf = (url: URL): string => {
  try {
    return decodeURIComponent(url.hash.slice(1));
  } catch {
    return url.hash.slice(1);
  }
};

const lostFragment = (href: string, url: URL, answer: Served): string[] => {
  const fragment = fragmentOf(url);
  return answer.kind === 'page' &&
    !BUILT_IN_FRAGMENTS.has(fragment) &&
    !idsOf(answer.page).has(fragment)
    ? [`${href}: no element has the id «${fragment}»`]
    : [];
};

/** None for a link off these sites' hosts. */
const linkProblems = (
  { site, sites }: { site: SiteBuild; sites: readonly SiteBuild[] },
  href: string,
  url: URL,
): [string, string][] => {
  const target = sites.find((any) => hostOf(any) === url.host);
  if (sites.some((any) => hostOf(any) === `www.${url.host}`)) {
    return [['P25', `${href} names an apex host that redirects to www`]];
  }
  if (target === undefined) {
    return [];
  }
  if (url.protocol !== 'https:') {
    return [['P25', `${href} is not https`]];
  }
  const answer = served(target, url.pathname);
  if (target !== site) {
    return failure(href, answer).map((message) => ['P25', message]);
  }
  const broken = failure(href, answer).map((message): [string, string] => ['P23', message]);
  return [
    ...broken,
    ...lostFragment(href, url, answer).map((message): [string, string] => ['P24', message]),
  ];
};

/** A page's links to these sites' hosts: on its own site without a redirect (P23), to an id
 *  there (P24); to another over https, at www, without a redirect (P25). */
const links = (site: SiteBuild, sites: readonly SiteBuild[], page: Page): Finding[] => {
  const base = urlOf(site, page);
  const problems = named(page.parsed, 'a').flatMap((anchor) => {
    const href = attribute(anchor, 'href') ?? '';
    const url = URL.canParse(href, base) ? new URL(href, base) : undefined;
    return url === undefined || !['http:', 'https:'].includes(url.protocol)
      ? []
      : linkProblems({ site, sites }, href, url);
  });
  const of = (rule: string): string[] => [
    ...new Set(problems.filter(([id]) => id === rule).map(([, message]) => message)),
  ];
  return [
    ...findings(failing('P23'), whereOf(page), of('P23')),
    ...findings(warning('P24'), whereOf(page), of('P24')),
    ...findings(failing('P25'), whereOf(page), of('P25')),
  ];
};

/** A known site serves the address as a page or file; another site's is not ours to judge. */
const resolves = (sites: readonly SiteBuild[], href: string): boolean => {
  const owner = siteAt(sites, href);
  if (owner === undefined) {
    return true;
  }
  const { kind } = served(owner, new URL(href).pathname);
  return kind === 'page' || kind === 'file';
};

const trailProblems = (own: string, trail: JsonObject): { errors: string[]; repeats: string[] } => {
  const items = listOf(trail['itemListElement']).filter((item) => isObject(item));
  const addresses = items.map((item) => textAt(item, 'item'));
  const last = addresses.at(-1);
  return {
    errors: [
      ...(items.every((item, at) => item['position'] === at + 1)
        ? []
        : ['the breadcrumb positions do not run 1 to n']),
      ...(last === undefined || last === own ? [] : [`the breadcrumb ends at ${last}, not ${own}`]),
    ],
    repeats: addresses
      .filter((address, at) => address !== undefined && addresses.indexOf(address) !== at)
      .map((address) => `the breadcrumb lists ${address ?? ''} twice`),
  };
};

/** The data's addresses resolve and its breadcrumbs end at the page (P20); its references name
 *  a node of the page's data, or one another site defines (P21). */
const dataLinks = (site: SiteBuild, sites: readonly SiteBuild[], page: Page): Finding[] => {
  const objects = blocksOf(page).flatMap((block) => objectsIn(block));
  const own = linked(page.parsed, 'canonical')[0] ?? urlOf(site, page).href;
  const trails = pageNodes(page)
    .filter((node) => typesOf(node).includes('BreadcrumbList'))
    .map((trail) => trailProblems(own, trail));
  const defined = new Set(
    [page, ...sites.filter((other) => other !== site).flatMap((other) => other.pages)].flatMap(
      (any) =>
        blocksOf(any).flatMap((block) =>
          objectsIn(block).flatMap((node) => idOf(node, true) ?? []),
        ),
    ),
  );
  const dangling = objects
    .flatMap((node) => idOf(node, false) ?? [])
    .filter((id) => !defined.has(id));
  return [
    ...findings(failing('P20'), whereOf(page), [
      ...objects
        .flatMap((node) => LINKING.map((key) => node[key]))
        .filter((value) => typeof value === 'string')
        .filter((href) => !resolves(sites, href))
        .map((href) => `${href} does not resolve without a redirect`),
      ...trails.flatMap(({ errors }) => errors),
    ]),
    ...findings(
      warning('P20'),
      whereOf(page),
      trails.flatMap(({ repeats }) => repeats),
    ),
    ...findings(
      failing('P21'),
      whereOf(page),
      [...new Set(dangling)].map((id) => `${id} is not defined`),
    ),
  ];
};

const fileAt = (site: SiteBuild, href: string): string | undefined => {
  if (!URL.canParse(href) || new URL(href).origin !== site.origin) {
    return undefined;
  }
  const answer = served(site, new URL(href).pathname);
  return answer.kind === 'file' ? answer.file : undefined;
};

type Robots = ReturnType<typeof robotsParser>;

/** The noindex pages robots.txt disallows, whose noindex no crawler then reads. */
const unreadNoindex = (site: SiteBuild, parsed: Robots): string[] =>
  site.pages
    .filter((page) => page.path !== undefined && meantNoindex(site, page))
    .map((page) => urlOf(site, page).href)
    .filter((href) => parsed.isAllowed(href, '*') !== true)
    .map((href) => `${href} is noindex and disallowed, so no crawler reads its noindex`);

/** The build's robots.txt names one of its sitemaps (S01), lets crawlers reach the listed pages
 *  (S02) and the noindex ones (S03), and keeps them out of what the profile disallows (S04). */
const robots = (site: SiteBuild, entries: readonly SitemapEntry[]): Finding[] => {
  const text = site.files.get(ROBOTS);
  if (text === undefined) {
    return findings(failing('S01'), ROBOTS, ['the build has no robots.txt']);
  }
  const parsed = robotsParser(`${site.origin}/${ROBOTS}`, text);
  const listed = parsed.getSitemaps();
  const pointed = listed.length > 0 && listed.every((href) => fileAt(site, href) !== undefined);
  return [
    ...findings(
      failing('S01'),
      ROBOTS,
      pointed ? [] : ['no Sitemap line names a sitemap of this build'],
    ),
    ...findings(
      failing('S02'),
      ROBOTS,
      entries.flatMap(({ loc }) =>
        CRAWLERS.filter((agent) => parsed.isAllowed(loc, agent) !== true).map(
          (agent) => `${loc} is disallowed for ${agent}`,
        ),
      ),
    ),
    ...findings(failing('S03'), ROBOTS, unreadNoindex(site, parsed)),
    ...findings(
      failing('S04'),
      ROBOTS,
      site.profile.disallow
        .filter((disallowed) => parsed.isDisallowed(`${site.origin}${disallowed}`, '*') !== true)
        .map((disallowed) => `${disallowed} is not disallowed`),
    ),
  ];
};

const readOne = (
  site: SiteBuild,
  file: string,
  root: string,
): { problems: string[]; entries: SitemapEntry[] } => {
  try {
    const sitemap = readSitemap(site.files.get(file) ?? '');
    const kind = sitemap.root === root && sitemap.namespace === SITEMAP_NAMESPACE;
    return {
      problems: kind ? [] : [`${file} is not a ${root} in the sitemaps.org namespace`],
      entries: [...sitemap.entries],
    };
  } catch (error) {
    return { problems: [`${file} is not well-formed XML: ${String(error)}`], entries: [] };
  }
};

const locationProblems = (site: SiteBuild, loc: string): string[] => {
  const url = URL.canParse(loc) ? new URL(loc) : undefined;
  if (url === undefined || url.origin !== site.origin || url.search !== '' || url.hash !== '') {
    return [`${loc} is not an address on ${site.origin} without a query or fragment`];
  }
  return served(site, url.pathname).kind === 'page'
    ? []
    : [`${loc} is not a page in the site's address style`];
};

const listing = (site: SiteBuild, entries: readonly SitemapEntry[]): string[] => {
  const locs = entries.map(({ loc }) => loc);
  return [
    ...locs.flatMap((loc) => locationProblems(site, loc)),
    ...locs.filter((loc, at) => locs.indexOf(loc) !== at).map((loc) => `${loc} is listed twice`),
  ];
};

const coverage = (site: SiteBuild, entries: readonly SitemapEntry[]): string[] => {
  const locs = new Set(entries.map(({ loc }) => loc));
  const wanted = new Set(
    site.pages.filter((page) => indexable(site, page)).map((page) => urlOf(site, page).href),
  );
  return [
    ...[...wanted]
      .filter((href) => !locs.has(href))
      .map((href) => `${href} is indexable and not listed`),
    ...[...locs]
      .filter((loc) => !wanted.has(loc))
      .map((loc) => `${loc} is listed and not an indexable page`),
  ];
};

/** Equal dates on every page read as the build's time. */
const dating = (entries: readonly SitemapEntry[], now: Date): string[] => {
  const dates = entries.map(({ lastmod = '' }) => lastmod);
  return [
    ...entries
      .filter(
        ({ lastmod = '' }) => !W3C_DATETIME.test(lastmod) || Date.parse(lastmod) > now.getTime(),
      )
      .map(
        ({ loc, lastmod = '' }) => `${loc} has lastmod «${lastmod}», not a W3C datetime up to now`,
      ),
    ...(dates.length > 1 && new Set(dates).size === 1 ? ['every lastmod is the same moment'] : []),
  ];
};

/** The index and its sitemaps parse (S05) and list each indexable page once (S05, S06), each
 *  dated up to now (S07). */
const sitemaps = (site: SiteBuild, now: Date): { entries: SitemapEntry[]; found: Finding[] } => {
  const index = readOne(site, INDEX, 'sitemapindex');
  const children = index.entries.map(({ loc }) => ({ loc, file: fileAt(site, loc) }));
  const files = children.flatMap(({ file }) => file ?? []);
  const read = children.map(({ loc, file }) =>
    file === undefined
      ? { problems: [`${loc} is not a file of the build`], entries: [] }
      : readOne(site, file, 'urlset'),
  );
  const entries = read.flatMap((one) => one.entries);
  const where = [INDEX, ...files].join(', ');
  return {
    entries,
    found: [
      ...findings(failing('S05'), INDEX, [
        ...index.problems,
        ...read.flatMap((one) => one.problems),
      ]),
      ...findings(failing('S05'), where, listing(site, entries)),
      ...findings(failing('S06'), where, coverage(site, entries)),
      ...findings(failing('S07'), where, dating(entries, now)),
    ],
  };
};

/** Nothing stray is published (S13); GitHub Pages, which a CNAME marks, adds a README.md, so
 *  robots.txt disallows it there. */
const stray = (site: SiteBuild): Finding[] => {
  const robotsText = site.files.get(ROBOTS);
  const readme =
    robotsText !== undefined &&
    robotsParser(`${site.origin}/${ROBOTS}`, robotsText).isDisallowed(
      `${site.origin}/README.md`,
      '*',
    ) === true;
  return findings(warning('S13'), ROBOTS, [
    ...[...site.files.keys()]
      .filter(
        (file) =>
          path.posix.basename(file) === 'README.md' || SOURCES.has(path.posix.extname(file)),
      )
      .map((file) => `${file} is published`),
    ...(site.files.has('CNAME') && !readme
      ? ['robots.txt does not disallow the README.md GitHub Pages adds']
      : []),
  ]);
};

/** Every rule that reads more than one page, on one site among all. */
export const siteFindings = (
  site: SiteBuild,
  sites: readonly SiteBuild[],
  now: Date,
): Finding[] => {
  const { entries, found } = sitemaps(site, now);
  return [
    ...site.pages.flatMap((page) => [...links(site, sites, page), ...dataLinks(site, sites, page)]),
    ...robots(site, entries),
    ...found,
    ...stray(site),
  ];
};
