import { directivesOf, keptOut, seoBasics } from '../checks/seo.ts';
import type { JsonObject } from '../unknown.ts';
import { indexable, meantNoindex, type Page, type SiteBuild, urlOf, whereOf } from './build.ts';
import { failing, type Finding, findings, warning } from './finding.ts';
import { factsOf, metaContents, named, plain, textOf } from './html.ts';
import { objectsIn, pageNodes, textAt, typesOf } from './json-ld.ts';
import { lacking } from './shapes.ts';

type PageRule = (site: SiteBuild, page: Page) => Finding[];

/** Characters, in bands wider than the usual 30 to 60 and 70 to 160: within them, the wording is
 *  each site's to choose. */
const TITLE = { min: 15, max: 70 };
const DESCRIPTION = { min: 50, max: 200 };
const OPEN_GRAPH = ['og:title', 'og:description', 'og:type', 'og:url', 'og:image'];
const OG_LOCALE = /^(?<language>[a-z]{2,3})_[A-Z]{2}$/u;
/** The nodes that stand for the page itself, at its canonical. */
const ADDRESSED = new Set(['WebPage', 'LearningResource', 'ProfilePage']);

const titlesOf = (page: Page): string[] =>
  named(page.parsed, 'title').map((title) => plain(textOf(title)));

const descriptionsOf = (page: Page): string[] =>
  metaContents(page.parsed, 'description').map((text) => plain(text));

const only = (values: readonly string[]): string | undefined =>
  values.length === 1 ? values[0] : undefined;

const outside = (what: string, text: string, band: typeof TITLE): string[] => {
  const { length } = [...new Intl.Segmenter().segment(text)];
  return length < band.min || length > band.max
    ? [
        `the ${what} is ${String(length)} characters, outside ${String(band.min)} to ${String(band.max)}: «${text}»`,
      ]
    : [];
};

const basics: PageRule = (_site, page) =>
  seoBasics(factsOf(page.parsed)).flatMap(([rule, message]) =>
    findings(failing(rule), whereOf(page), [message]),
  );

/** One title with text (P02) and one description (P05), each in its band on an indexable page. */
const wording: PageRule = (site, page) => {
  const where = whereOf(page);
  const titles = titlesOf(page);
  const descriptions = descriptionsOf(page);
  const [title, description] = [only(titles), only(descriptions)];
  const judged = indexable(site, page);
  return [
    ...findings(
      failing('P02'),
      where,
      title === undefined || title === '' ? [`${String(titles.length)} titles, not one`] : [],
    ),
    ...findings(
      failing('P03'),
      where,
      judged && title !== undefined ? outside('title', title, TITLE) : [],
    ),
    ...findings(
      failing('P05'),
      where,
      descriptions.length > 1 ? [`${String(descriptions.length)} meta descriptions`] : [],
    ),
    ...findings(
      failing('P06'),
      where,
      judged && description !== undefined ? outside('description', description, DESCRIPTION) : [],
    ),
  ];
};

/** An indexable page's canonical is its own URL (P10); robots say noindex where meant (P11). */
const indexing: PageRule = (site, page) => {
  const { robots, canonicals } = factsOf(page.parsed);
  const own = urlOf(site, page).href;
  const canonical = only(canonicals);
  const meant = meantNoindex(site, page);
  const unmeant = meant
    ? []
    : directivesOf(robots).filter((word) => word === 'noindex' || word === 'none');
  const unsaid = meant && !keptOut(robots);
  const wrong =
    !meant && !keptOut(robots) && canonical !== undefined && canonical !== '' && canonical !== own;
  return [
    ...findings(
      failing('P10'),
      whereOf(page),
      wrong ? [`the canonical is ${canonical}, not ${own}`] : [],
    ),
    ...findings(failing('P11'), whereOf(page), [
      ...(unsaid
        ? ['the page is meant to be kept out of the index, and has no robots noindex']
        : []),
      ...unmeant.map((word) => `robots ${word} on a page meant for the index`),
    ]),
  ];
};

const imageProblems = (site: SiteBuild, image: string): string[] => {
  if (!URL.canParse(image) || new URL(image).protocol !== 'https:') {
    return [`og:image ${image} is not an absolute https URL`];
  }
  const { origin, pathname } = new URL(image);
  return origin !== site.origin || site.files.has(decodeURIComponent(pathname).slice(1))
    ? []
    : [`og:image ${image} is not in the build`];
};

const localeProblems = (locale: string | undefined, lang: string): string[] => {
  const { groups } = OG_LOCALE.exec(locale ?? '') ?? { groups: undefined };
  const [language] = lang.toLowerCase().split('-');
  return groups !== undefined && groups['language'] === language
    ? []
    : [`og:locale is ${locale ?? 'missing'}, not language_TERRITORY in ${lang}`];
};

/** Open Graph once each on an indexable page (P12), its image described (P14), its locale (P15). */
const card: PageRule = (site, page) => {
  const meta = (key: string): string[] => metaContents(page.parsed, key);
  const indexed = indexable(site, page);
  const own = urlOf(site, page).href;
  const url = only(meta('og:url'));
  const counted = OPEN_GRAPH.filter((key) => meta(key).length !== 1);
  const images = meta('og:image');
  const alt = only(meta('og:image:alt')) ?? '';
  const locale = only(meta('og:locale'));
  return [
    ...findings(failing('P12'), whereOf(page), [
      ...(indexed ? counted.map((key) => `${String(meta(key).length)} ${key}, not one`) : []),
      ...(indexed && url !== undefined && url !== own ? [`og:url is ${url}, not ${own}`] : []),
      ...images.flatMap((image) => imageProblems(site, image)),
    ]),
    ...findings(
      warning('P14'),
      whereOf(page),
      images.length > 0 && alt.trim() === '' ? ['og:image has no og:image:alt'] : [],
    ),
    ...findings(warning('P15'), whereOf(page), localeProblems(locale, factsOf(page.parsed).lang)),
  ];
};

/** A value given, and other than the one wanted. */
const differs = (value: string | undefined, wanted: string): boolean =>
  value !== undefined && value !== wanted;

/** Where an addressed node's url, and a page's @id, name other than the canonical URL `own`. */
const misplaced = (
  node: JsonObject,
  types: readonly string[],
  own: string | undefined,
): string[] => {
  if (own === undefined || !types.some((type) => ADDRESSED.has(type))) {
    return [];
  }
  const [address, id] = [textAt(node, 'url'), textAt(node, '@id')];
  return [
    ...(differs(address, own) ? [`url is ${String(address)}, not ${own}`] : []),
    ...(types.includes('WebPage') && differs(id, own) ? [`@id is ${String(id)}, not ${own}`] : []),
  ];
};

const disagreements = (node: JsonObject, page: Page): string[] => {
  const { canonicals, lang } = factsOf(page.parsed);
  const types = typesOf(node);
  const [name, language] = [textAt(node, 'name'), textAt(node, 'inLanguage')];
  const title = only(titlesOf(page));
  return [
    ...misplaced(node, types, only(canonicals)),
    ...(types.includes('WebPage') && title !== undefined && name !== title
      ? [`name is «${name ?? ''}», not the title «${title}»`]
      : []),
    ...(language === undefined || language === lang
      ? []
      : [`inLanguage is ${language}, not ${lang}`]),
  ].map((problem) => `${types.join(', ')} ${problem}`);
};

/** An FAQ's questions and answers are on the page, as Google requires. */
const unshown = (node: JsonObject, body: string): string[] =>
  (typesOf(node).includes('FAQPage') ? objectsIn(node['mainEntity']) : [])
    .flatMap((item) => [textAt(item, 'name'), textAt(item, 'text')])
    .filter((value) => value !== undefined && !body.includes(plain(value)))
    .map((value) => `the FAQ's «${value ?? ''}» is not on the page`);

/** Each node has what its type requires (P18) and agrees with the page (P19). */
const data: PageRule = (site, page) => {
  const nodes = pageNodes(page);
  const body = plain(
    named(page.parsed, 'body')
      .map((element) => textOf(element))
      .join(' '),
  );
  return [
    ...findings(
      failing('P18'),
      whereOf(page),
      nodes.flatMap((node) => lacking(node, typesOf(node), site)),
    ),
    ...findings(failing('P19'), whereOf(page), [
      ...nodes.flatMap((node) => disagreements(node, page)),
      ...nodes.flatMap((node) => unshown(node, body)),
    ]),
  ];
};

export const PAGE_RULES: readonly PageRule[] = [basics, wording, indexing, card, data];

const shared = (
  site: SiteBuild,
  valueOf: (page: Page) => string | undefined,
): (readonly [string, string])[] =>
  [
    ...Map.groupBy(
      site.pages.filter((page) => indexable(site, page)),
      (page) => valueOf(page),
    ),
  ]
    .filter(([value, group]) => value !== undefined && value !== '' && group.length > 1)
    .map(([value, group]) => [value ?? '', group.map((page) => whereOf(page)).join(', ')]);

/** No two indexable pages share a title (P04) or a description (P07). */
export const uniqueness = (site: SiteBuild): Finding[] => [
  ...shared(site, (page) => only(titlesOf(page))).flatMap(([value, where]) =>
    findings(failing('P04'), where, [`these pages share the title «${value}»`]),
  ),
  ...shared(site, (page) => only(descriptionsOf(page))).flatMap(([value, where]) =>
    findings(failing('P07'), where, [`these pages share the description «${value}»`]),
  ),
];
