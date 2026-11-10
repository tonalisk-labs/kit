// Each site rule passes the example site and names the file it read when one thing is wrong.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSitemap } from '../src/seo/sitemap.ts';
import { DATED, DIRECTORY, directorySite, page, rulesOf, sitemap } from './seo-sites.ts';

const SITEMAPS = 'sitemap-index.xml, sitemap-0.xml';

const robotsWith = (lines: string): string =>
  `User-agent: *\nAllow: /\n${lines}\nSitemap: ${DIRECTORY}/sitemap-index.xml\n`;

const listing = (...entries: (readonly [string, string | undefined])[]): string =>
  sitemap('urlset', entries);

/** The example site's findings with its two pages dated so; '' leaves the second undated. */
const dated = (home: string, about: string): string[] => {
  const xml = listing(
    [`${DIRECTORY}/`, home],
    [`${DIRECTORY}/about/`, about === '' ? undefined : about],
  );
  return rulesOf(directorySite({ 'sitemap-0.xml': xml }));
};

await test('a sitemap is read as XML: its root, namespace and entries; ill-formed XML throws', () => {
  assert.deepEqual(readSitemap(listing([`${DIRECTORY}/`, DATED[0]])), {
    root: 'urlset',
    namespace: 'http://www.sitemaps.org/schemas/sitemap/0.9',
    entries: [{ loc: `${DIRECTORY}/`, lastmod: DATED[0] }],
  });
  assert.throws(() => readSitemap('<urlset><url></urlset>'));
});

await test('no robots.txt, or one that names no sitemap of the build, fails S01', () => {
  assert.deepEqual(rulesOf(directorySite({ 'robots.txt': undefined })), ['S01 error robots.txt']);
  const elsewhere = `User-agent: *\nAllow: /\nSitemap: ${DIRECTORY}/elsewhere.xml\n`;
  assert.deepEqual(rulesOf(directorySite({ 'robots.txt': elsewhere })), ['S01 error robots.txt']);
});

await test('robots.txt hiding a listed or a noindex page, or open where it must not be, fails S02 to S04', () => {
  const blocked = directorySite({ 'robots.txt': robotsWith('Disallow: /about/') });
  assert.deepEqual(rulesOf(blocked), ['S02 error robots.txt']);
  const hidden = directorySite(
    {
      'about/index.html': page(DIRECTORY, '/about/', { noindex: true }),
      'sitemap-0.xml': listing([`${DIRECTORY}/`, DATED[0]]),
      'robots.txt': robotsWith('Disallow: /about/'),
    },
    { noindex: ['/about/'], disallow: ['/api/'] },
  );
  assert.deepEqual(rulesOf(hidden), ['S03 error robots.txt', 'S04 error robots.txt']);
  const closed = directorySite(
    { 'robots.txt': robotsWith('Disallow: /api/') },
    { noindex: [], disallow: ['/api/'] },
  );
  assert.deepEqual(rulesOf(closed), []);
});

await test('a location with a query, listed twice, or a sitemap that does not parse fails S05', () => {
  const query = listing([`${DIRECTORY}/`, DATED[0]], [`${DIRECTORY}/about/?a=1`, DATED[1]]);
  assert.deepEqual(rulesOf(directorySite({ 'sitemap-0.xml': query })), [
    `S05 error ${SITEMAPS}`,
    `S06 error ${SITEMAPS}`,
  ]);
  const about = `${DIRECTORY}/about/`;
  const twice = listing([`${DIRECTORY}/`, DATED[0]], [about, DATED[1]], [about, DATED[0]]);
  assert.deepEqual(rulesOf(directorySite({ 'sitemap-0.xml': twice })), [`S05 error ${SITEMAPS}`]);
  assert.deepEqual(rulesOf(directorySite({ 'sitemap-0.xml': '<urlset><url></urlset>' })), [
    'S05 error sitemap-index.xml',
    `S06 error ${SITEMAPS}`,
  ]);
});

await test('a noindex page listed, or an indexable page left out, fails S06', () => {
  const short = directorySite({ 'sitemap-0.xml': listing([`${DIRECTORY}/`, DATED[0]]) });
  assert.deepEqual(rulesOf(short), [`S06 error ${SITEMAPS}`]);
  const listed = directorySite(
    { 'about/index.html': page(DIRECTORY, '/about/', { noindex: true }) },
    { noindex: ['/about/'], disallow: [] },
  );
  assert.deepEqual(rulesOf(listed), [`S06 error ${SITEMAPS}`]);
});

await test('an undated, future or build-stamped lastmod fails S07; dates of their own pass', () => {
  const failed = [`S07 error ${SITEMAPS}`];
  assert.deepEqual(dated(DATED[0], ''), failed);
  assert.deepEqual(dated(DATED[0], '2027-01-01'), failed);
  assert.deepEqual(dated(DATED[0], '2026-10-01T10:00'), failed);
  assert.deepEqual(dated('2026-10-02', '2026-10-02'), failed);
  assert.deepEqual(dated('2026-10-02', '2026-10-01'), []);
});

await test('a published README or source map, or GitHub Pages’ README let in, warns under S13', () => {
  assert.deepEqual(rulesOf(directorySite({ 'README.md': 'Notes' })), ['S13 warn robots.txt']);
  assert.deepEqual(rulesOf(directorySite({ 'app.js.map': '{}' })), ['S13 warn robots.txt']);
  assert.deepEqual(rulesOf(directorySite({ CNAME: 'www.example.com' })), ['S13 warn robots.txt']);
  const kept = { CNAME: 'www.example.com', 'robots.txt': robotsWith('Disallow: /README.md') };
  assert.deepEqual(rulesOf(directorySite(kept)), []);
});
