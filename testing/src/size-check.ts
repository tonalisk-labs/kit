#!/usr/bin/env node
// The size check over every site's build (checks/size.ts), each held to its budget in the repo's
// budgets file (`--budgets spec/budgets.json`, `perf-budgets.json` by default): what a page
// downloads before it is usable, its stylesheets, what it loads later and its wasm, in brotli
// bytes. A site is named by its folder in the repo (`web`, or `.` for one at the root), which no
// checkout's own name changes. `--write` sets each site's budget to what it measures.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';

import { type Build, overBudget, type SiteSize, type SizeBudget, sizeOf } from './checks/size.ts';
import { discover, REPO } from './discover.ts';
import { BUDGETS_ENV, budgetsFile, sizeBudget } from './perf/budgets.ts';
import { isObject } from './unknown.ts';

const { values } = parseArgs({
  options: { write: { type: 'boolean', default: false }, budgets: { type: 'string' } },
});
if (values.budgets !== undefined) {
  process.env[BUDGETS_ENV] = values.budgets;
}
/** The budgets file, named from the repo's root. */
const BUDGETS_FILE = path.relative(REPO, budgetsFile());

const buildOf = (dist: string): Build => {
  if (!existsSync(dist)) {
    throw new Error(`${dist} holds no build; run the site's build first`);
  }
  return new Map(
    readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return [path.relative(dist, full).split(path.sep).join('/'), readFileSync(full)];
      }),
  );
};

const budgetOf = (site: string): SizeBudget => {
  const ceilings = sizeBudget(site);
  const read = (key: keyof SizeBudget): number => {
    const value = ceilings[key];
    if (value === undefined) {
      throw new Error(`${BUDGETS_FILE} gives ${site} no ${key} size`);
    }
    return value;
  };
  return { eager: read('eager'), css: read('css'), lazy: read('lazy'), wasm: read('wasm') };
};

const KIB = 1024;
const kib = (bytes: number): string => `${(bytes / KIB).toFixed(1)} KiB`;

/** The largest page of each kind, which is what its budget is set by. */
const measured = (size: SiteSize): SizeBudget => ({
  eager: Math.max(0, ...size.pages.map(({ eager }) => eager)),
  css: Math.max(0, ...size.pages.map(({ css }) => css)),
  lazy: size.lazy,
  wasm: size.wasm,
});

const lines = (site: string, size: SiteSize, budget: SizeBudget): string[] => {
  const most = measured(size);
  return [
    styleText('bold', `${site} (${String(size.pages.length)} pages)`),
    ...(['eager', 'css', 'lazy', 'wasm'] as const).map((key) => {
      const mark = most[key] > budget[key] ? styleText('red', '✗') : styleText('green', '✓');
      return `  ${mark} ${key.padEnd(5)} ${kib(most[key]).padStart(10)} of ${kib(budget[key])}`;
    }),
  ];
};

const summary = (rows: readonly (readonly [string, SiteSize, SizeBudget])[]): string =>
  [
    '### Size, in brotli bytes',
    '',
    '| Site | Eager, largest page | CSS, largest page | Later | Wasm |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(([site, size, budget]) => {
      const most = measured(size);
      const cell = (key: keyof SizeBudget): string =>
        `${kib(most[key])} of ${kib(budget[key])}${most[key] > budget[key] ? ' ✗' : ''}`;
      return `| ${site} | ${cell('eager')} | ${cell('css')} | ${cell('lazy')} | ${cell('wasm')} |`;
    }),
    '',
  ].join('\n');

/** The repo's budgets file with each site's `sizes` set to what it measures, its other sections
 *  kept as they are. */
const written = (rows: readonly (readonly [string, SiteSize])[]): void => {
  const file = budgetsFile();
  const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const own = isObject(parsed) ? parsed : {};
  const sizes = Object.fromEntries(rows.map(([site, size]) => [site, measured(size)]));
  writeFileSync(file, `${JSON.stringify(Object.assign(own, { sizes }), undefined, 2)}\n`);
  console.log(`${file}: each site's size budget is what it measures`);
};

const rows = discover().map(
  (target) =>
    [
      path.relative(REPO, target.root) || '.',
      sizeOf(buildOf(path.join(target.root, 'dist'))),
    ] as const,
);
if (values.write) {
  written(rows);
}
// The budgets were read as this started: once rewritten, each site is shown against its new one.
const judged = rows.map(
  ([site, size]) => [site, size, values.write ? measured(size) : budgetOf(site)] as const,
);
const over = judged.flatMap(([site, size, budget]) =>
  overBudget(size, budget).map((line) => `${site}: ${line}`),
);
console.log(judged.flatMap(([site, size, budget]) => lines(site, size, budget)).join('\n'));
const report = process.env['GITHUB_STEP_SUMMARY'];
if (report !== undefined && report !== '') {
  appendFileSync(report, summary(judged));
}
if (over.length > 0) {
  console.log(`\n${over.map((line) => styleText('red', line)).join('\n')}`);
}
process.exitCode = over.length > 0 ? 1 : 0;
