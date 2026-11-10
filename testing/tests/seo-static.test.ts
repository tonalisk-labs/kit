// Each page rule passes the example site and names the page and itself when one thing is wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seoBasics, seoProblems } from '../src/checks/seo.ts';
import type { SiteBuild } from '../src/seo/build.ts';
import { factsOf, parseHtml } from '../src/seo/html.ts';
import {
  descriptionAt,
  DIRECTORY,
  directorySite,
  FILE,
  fileSite,
  page,
  type PageParts,
  report,
  rulesOf,
  titleAt,
} from './seo-sites.ts';

const ABOUT = 'about/index.html';
const NOINDEX = { noindex: ['/about/'], disallow: [] };

const about = (parts: PageParts = {}): string => page(DIRECTORY, '/about/', parts);

const withAbout = (parts: PageParts): string[] => rulesOf(directorySite({ [ABOUT]: about(parts) }));

const swapped = (from: string, to: string): string[] =>
  rulesOf(directorySite({ [ABOUT]: about().replace(from, to) }));

const fileWith = (body: string): string[] =>
  rulesOf(fileSite({ 'about.html': page(FILE, '/about', { body }) }));

/** «𝄞» is one character and two UTF-16 units. */
const clefs = (count: number): string => '𝄞'.repeat(count);

const crumb = (position: number, item: string): object => ({
  '@type': 'ListItem',
  position,
  name: 'Step',
  item,
});

const trail = (...items: object[]): object[] => [
  { '@type': 'BreadcrumbList', itemListElement: items },
];

const linking = (href: string): SiteBuild =>
  directorySite({ [ABOUT]: about({ body: `<a href="${href}">Them</a>` }) });

const film = (uploadDate: string): object => ({
  '@type': 'VideoObject',
  name: 'A film',
  description: 'What it shows',
  thumbnailUrl: `${DIRECTORY}/card.png`,
  contentUrl: `${DIRECTORY}/film.mp4`,
  uploadDate,
});

const AUTHOR = {
  '@type': 'WebSite',
  name: 'A',
  url: `${DIRECTORY}/`,
  author: { '@id': `${FILE}/#person` },
};
const PERSON = { '@type': 'Person', '@id': `${FILE}/#person`, name: 'Ana', url: `${FILE}/` };

await test('the example site passes every rule, in either URL style', () => {
  assert.deepEqual(report(directorySite()), []);
  assert.deepEqual(report(fileSite()), []);
});

await test('the e2e sweep’s basics read the same facts from the built page', () => {
  const facts = factsOf(parseHtml('<html><head></head><body><h1>a</h1><h1>b</h1></body></html>'));
  assert.deepEqual(
    seoBasics(facts).map(([rule]) => rule),
    ['P01', 'P10', 'P05', 'P08', 'P17'],
  );
  assert.deepEqual(seoProblems(facts), [
    '<html> has no lang',
    '0 canonical links, not one with an href',
    'no meta description',
    '2 h1 elements, not one',
    'no JSON-LD',
  ]);
});

await test('titles count characters: 15 and 70 pass, 14 and 71 fail P03', () => {
  assert.deepEqual(withAbout({ title: clefs(15) }), []);
  assert.deepEqual(withAbout({ title: clefs(70) }), []);
  assert.deepEqual(withAbout({ title: clefs(14) }), ['P03 error /about/']);
  assert.deepEqual(withAbout({ title: clefs(71) }), ['P03 error /about/']);
});

await test('two titles fail P02; a title or description two pages share fails P04 or P07', () => {
  assert.deepEqual(withAbout({ head: '<title>Another</title>' }), ['P02 error /about/']);
  assert.deepEqual(withAbout({ title: titleAt('/') }), ['P04 error /about/, /']);
  assert.deepEqual(withAbout({ description: descriptionAt('/') }), ['P07 error /about/, /']);
});

await test('two descriptions fail P05; one outside 50 to 200 fails P06', () => {
  assert.deepEqual(withAbout({ head: '<meta name="description" content="Again">' }), [
    'P05 error /about/',
  ]);
  assert.deepEqual(withAbout({ description: 'Too short to say anything.' }), ['P06 error /about/']);
});

await test('a canonical in the other URL style, or over http, fails P10, and P19 with it', () => {
  const both = ['P10 error /about/', 'P19 error /about/'];
  assert.deepEqual(withAbout({ canonical: `${DIRECTORY}/about` }), both);
  assert.deepEqual(withAbout({ canonical: 'http://www.example.com/about/' }), both);
  const slashed = page(FILE, '/about', { canonical: `${FILE}/about/` });
  assert.deepEqual(rulesOf(fileSite({ 'about.html': slashed })), [
    'P10 error /about',
    'P19 error /about',
  ]);
});

await test('a page meant to be noindex without it, or noindex where it is not meant, fails P11', () => {
  assert.ok(rulesOf(directorySite({}, NOINDEX)).includes('P11 error /about/'));
  assert.ok(withAbout({ noindex: true }).includes('P11 error /about/'));
  const meant = directorySite({ [ABOUT]: about({ noindex: true }) }, NOINDEX);
  assert.deepEqual(
    rulesOf(meant).filter((rule) => rule.startsWith('P')),
    [],
  );
});

await test('Open Graph missing, its image unnamed or its locale another language fail P12 to P15', () => {
  assert.deepEqual(swapped('<meta property="og:type" content="website">', ''), [
    'P12 error /about/',
  ]);
  assert.deepEqual(swapped('/card.png', '/lost.png'), ['P12 error /about/']);
  assert.deepEqual(swapped('<meta property="og:image:alt" content="The card">', ''), [
    'P14 warn /about/',
  ]);
  assert.deepEqual(swapped('content="en_GB"', 'content="pt_PT"'), ['P15 warn /about/']);
});

await test('JSON-LD short of its type, or at odds with the page, fails P18 or P19', () => {
  assert.deepEqual(withAbout({ data: [{ '@type': 'Person', url: DIRECTORY }] }), [
    'P18 error /about/',
  ]);
  assert.deepEqual(withAbout({ data: [{ '@type': 'Recipe', name: 'Soup' }] }), []);
  // Unlike a sitemap's W3C datetime, ISO 8601 lets a time leave out its zone.
  assert.deepEqual(withAbout({ data: [film('2026-10-01T10:00')] }), []);
  assert.deepEqual(withAbout({ data: [film('1 October')] }), ['P18 error /about/']);
  const elsewhere = { '@type': 'LearningResource', name: 'A', url: `${DIRECTORY}/` };
  assert.deepEqual(withAbout({ data: [elsewhere] }), ['P19 error /about/']);
});

await test('breadcrumbs end at the page and name each page once; data links resolve (P20)', () => {
  const home = crumb(1, `${DIRECTORY}/`);
  const [ending, looped] = [crumb(2, `${DIRECTORY}/about/`), crumb(2, `${DIRECTORY}/`)];
  assert.deepEqual(withAbout({ data: trail(home, ending) }), []);
  assert.deepEqual(withAbout({ data: trail(home, looped) }), [
    'P20 error /about/',
    'P20 warn /about/',
  ]);
  assert.deepEqual(withAbout({ data: [{ '@type': 'Thing', url: `${DIRECTORY}/about` }] }), [
    'P20 error /about/',
  ]);
});

await test('a reference to a node no site defines fails P21; one another site defines passes', () => {
  assert.deepEqual(withAbout({ data: [AUTHOR] }), ['P21 error /about/']);
  const defined = fileSite({ 'index.html': page(FILE, '/', { data: [PERSON] }) });
  const referring = directorySite({ [ABOUT]: about({ data: [AUTHOR] }) });
  assert.deepEqual(rulesOf(referring, defined), []);
});

await test('a link that works only through a redirect fails P23, in the site’s own URL style', () => {
  assert.deepEqual(withAbout({ body: '<a href="/about">About</a>' }), ['P23 error /about/']);
  assert.deepEqual(withAbout({ body: '<a href="/about/index.html">About</a>' }), [
    'P23 error /about/',
  ]);
  assert.deepEqual(
    withAbout({ body: '<a href="/about/">About</a> <a href="/card.png">Card</a>' }),
    [],
  );
  assert.deepEqual(fileWith('<a href="/about/">About</a>'), ['P23 error /about']);
  assert.deepEqual(fileWith('<a href="/about.html">About</a>'), ['P23 error /about']);
  assert.deepEqual(fileWith('<a href="/about#top" id="top">About</a>'), []);
  assert.deepEqual(fileWith('<a href="/missing">Missing</a>'), ['P23 error /about']);
});

await test('a link to an id the page lacks warns under P24', () => {
  assert.deepEqual(withAbout({ body: '<a href="/#nowhere">Home</a>' }), ['P24 warn /about/']);
});

await test('a link to a sibling site over http, at its apex, or redirected fails P25', () => {
  const sibling = fileSite();
  assert.deepEqual(rulesOf(linking(`${FILE}/about`), sibling), []);
  assert.deepEqual(rulesOf(linking(`${FILE}/about/`), sibling), ['P25 error /about/']);
  assert.deepEqual(rulesOf(linking('http://www.example.org/about'), sibling), [
    'P25 error /about/',
  ]);
  assert.deepEqual(rulesOf(linking('https://example.org/about'), sibling), ['P25 error /about/']);
});
