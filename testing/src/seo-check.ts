#!/usr/bin/env node
// The static SEO check over every site's build (checks/seo-static.ts).
// Errors fail the run; warnings fail it only with --strict.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { styleText } from 'node:util';

import { loadAdapter } from './adapter.ts';
import { type Finding, loadSite, staticFindings } from './checks/seo-static.ts';
import { discover } from './discover.ts';

const strict = process.argv.includes('--strict');

const formatSite = (name: string, found: readonly Finding[], pages: number): string[] => {
  const lines: string[] = [];
  for (const [where, items] of Map.groupBy(found, (finding) => finding.where)) {
    const failed = items.some(({ severity }) => severity === 'error');
    lines.push(`  ${failed ? styleText('red', '✗') : styleText('yellow', '!')} ${where}`);
    for (const { rule, severity, message } of items) {
      const colour = severity === 'error' ? 'red' : 'yellow';
      lines.push(styleText(colour, `    ${rule} ${severity}: ${message}`));
    }
  }
  const passed = `  ${styleText('green', '✓')} every rule passes`;
  return [
    `${styleText('bold', name)} (${String(pages)} pages)`,
    ...(lines.length === 0 ? [passed] : lines),
  ];
};

const sites = await Promise.all(
  discover().map(async (target) => {
    const adapter = await loadAdapter(target.adapter);
    return loadSite(
      target.name,
      path.join(target.root, 'dist'),
      adapter === undefined ? undefined : adapter.seo,
    );
  }),
);
const bySite = staticFindings(sites);
for (const [site, found] of bySite) {
  console.log(formatSite(site.name, found, site.pages.length).join('\n'));
}
const all = [...bySite.values()].flat();
const errors = all.filter(({ severity }) => severity === 'error').length;
const warnings = all.length - errors;
const pages = sites.reduce((total, site) => total + site.pages.length, 0);
console.log(
  `\n${String(pages)} pages on ${String(sites.length)} sites: ${String(errors)} errors, ${String(warnings)} warnings.`,
);
// A shallow clone cannot date a page last changed before it begins.
const shallow = (): boolean =>
  execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() ===
  'true';
if (all.some(({ rule }) => rule === 'S07') && shallow()) {
  console.log('This clone is shallow; a full clone (fetch-depth: 0) dates every page.');
}
process.exitCode = errors > 0 || (strict && warnings > 0) ? 1 : 0;
