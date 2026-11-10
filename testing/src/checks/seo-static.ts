// The SEO check of built sites, without a browser: the rules do no I/O; loadSite reads a build.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { SeoProfile } from '../adapter.ts';
import { type SiteBuild, siteOf, TEXT } from '../seo/build.ts';
import type { Finding } from '../seo/finding.ts';
import { PAGE_RULES, uniqueness } from '../seo/page-rules.ts';
import { siteFindings } from '../seo/site-rules.ts';

export type { Finding } from '../seo/finding.ts';

export const loadSite = (name: string, dist: string, profile?: SeoProfile): SiteBuild => {
  const files = new Map(
    readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        const file = path.relative(dist, full).split(path.sep).join('/');
        return [file, TEXT.has(path.extname(file)) ? readFileSync(full, 'utf8') : undefined];
      }),
  );
  if (![...files.keys()].some((file) => file.endsWith('.html'))) {
    throw new Error(`${name} has no built pages in ${dist}; run \`npm run build\` first`);
  }
  return siteOf(name, files, profile);
};

/** Each site's findings; no sitemap date may be later than `now`. */
export const staticFindings = (
  sites: readonly SiteBuild[],
  now = new Date(),
): Map<SiteBuild, Finding[]> =>
  new Map(
    sites.map((site) => [
      site,
      [
        ...site.pages.flatMap((page) => PAGE_RULES.flatMap((rule) => rule(site, page))),
        ...uniqueness(site),
        ...siteFindings(site, sites, now),
      ],
    ]),
  );
