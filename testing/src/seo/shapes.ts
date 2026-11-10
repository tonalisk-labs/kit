// What each schema.org type the sites use requires of a node, by Google's structured data rules.
import { isObject, type JsonObject } from '../unknown.ts';
import type { SiteBuild } from './build.ts';
import { listOf, textAt } from './json-ld.ts';

type Shape = (node: JsonObject, site: SiteBuild) => string[];

/** An ISO 8601 date, or date and time; a W3C datetime, the sitemaps' form, must give the zone. */
const datetime = (zone: '' | '?'): RegExp =>
  new RegExp(
    String.raw`^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})${zone})?$`,
    'u',
  );
export const W3C_DATETIME = datetime('');
const ISO_DATETIME = datetime('?');

const isText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const isUrl = (value: unknown): boolean => typeof value === 'string' && URL.canParse(value);

const text =
  (key: string): Shape =>
  (node) =>
    isText(node[key]) ? [] : [`no ${key}`];

const url =
  (key: string): Shape =>
  (node) => {
    const all = listOf(node[key]);
    return all.length > 0 && all.every((item) => isUrl(item))
      ? []
      : [`${key} is not an absolute URL`];
  };

const either =
  (first: Shape, second: Shape, what: string): Shape =>
  (node, site) =>
    first(node, site).length === 0 || second(node, site).length === 0 ? [] : [`no ${what}`];

const home: Shape = (node, site) =>
  textAt(node, 'url') === `${site.origin}/` ? [] : [`url is not ${site.origin}/`];

const offers: Shape = (node) => {
  const all = listOf(node['offers']);
  const priced = all.every(
    (offer) =>
      isObject(offer) &&
      ['string', 'number'].includes(typeof offer['price']) &&
      isText(offer['priceCurrency']),
  );
  return all.length > 0 && priced ? [] : ['no offers with a price and its currency'];
};

const uploaded: Shape = (node) =>
  ISO_DATETIME.test(textAt(node, 'uploadDate') ?? '') ? [] : ['uploadDate is not ISO 8601'];

const questions: Shape = (node) => {
  const all = listOf(node['mainEntity']);
  const answered = all.every(
    (question) =>
      isObject(question) &&
      isText(question['name']) &&
      isObject(question['acceptedAnswer']) &&
      isText(question['acceptedAnswer']['text']),
  );
  return all.length > 0 && answered ? [] : ['mainEntity is not questions with accepted answers'];
};

/** Every crumb but the last links its page. */
const crumbs: Shape = (node) => {
  const all = listOf(node['itemListElement']);
  const listed = all.every(
    (item, at) =>
      isObject(item) &&
      typeof item['position'] === 'number' &&
      isText(item['name']) &&
      (at === all.length - 1 || isUrl(item['item'])),
  );
  return all.length > 0 && listed ? [] : ['itemListElement is not list items, named and placed'];
};

const entity: Shape = (node) => (isObject(node['mainEntity']) ? [] : ['no mainEntity']);
const authored: Shape = (node) => (node['author'] === undefined ? ['no author'] : []);
const titled = either(text('name'), text('headline'), 'name or headline');

const SHAPES: ReadonlyMap<string, readonly Shape[]> = new Map([
  ['WebSite', [text('name'), home]],
  ['WebPage', [either(url('url'), url('@id'), 'url or @id'), text('name')]],
  ['Organization', [text('name'), url('url')]],
  ['Person', [text('name'), url('url')]],
  [
    'SoftwareApplication',
    [text('name'), url('url'), text('applicationCategory'), text('operatingSystem'), offers],
  ],
  [
    'VideoObject',
    [
      text('name'),
      text('description'),
      url('thumbnailUrl'),
      uploaded,
      either(url('contentUrl'), url('embedUrl'), 'contentUrl or embedUrl'),
    ],
  ],
  ['FAQPage', [questions]],
  ['BreadcrumbList', [crumbs]],
  ['ProfilePage', [entity]],
  ['LearningResource', [titled, url('url')]],
  ['Article', [titled, url('url')]],
  ['TechArticle', [titled, url('url')]],
  ['Book', [text('name'), authored, url('url')]],
]);

/** A type with no shape here is not judged. */
export const lacking = (node: JsonObject, types: readonly string[], site: SiteBuild): string[] =>
  types.flatMap((type) =>
    (SHAPES.get(type) ?? []).flatMap((shape) =>
      shape(node, site).map((problem) => `${type}: ${problem}`),
    ),
  );
