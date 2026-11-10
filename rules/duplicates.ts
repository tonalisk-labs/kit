#!/usr/bin/env node
// Fails on any duplicate block over 10 lines in the folders named (`.` by default), measured as
// every tonalisk-labs repo is: jscpd 5.4.2, the repo's own devDependency, with the flags below.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** The jscpd every project measures with, so each count means the same. */
export const JSCPD_VERSION = '5.4.2';

/** The formats a repo's code is measured in by default, TypeScript compared with TSX. */
export const FORMATS = 'typescript,tsx,javascript,swift,rust';

/** The arguments jscpd takes for `folders`, in `formats`, its report written to `output`. */
export const jscpdArguments = (
  formats: string,
  output: string,
  folders: readonly string[],
): string[] => [
  '--min-lines',
  '11',
  '--format',
  formats,
  '--cross-formats',
  'js-ts',
  '--workers',
  '3',
  '--absolute',
  '--reporters',
  'json,silent',
  '--output',
  output,
  '--no-tips',
  '--no-colors',
  ...folders,
];

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

/** A clone's place, as its file relative to `root` and its first and last lines. */
const placeOf = (file: unknown, root: string): string =>
  `${path.relative(root, String(field(file, 'name')))}:${String(field(file, 'start'))}-${String(field(file, 'end'))}`;

/** Each clone in a jscpd report, as one line naming both places. */
export const clonesIn = (report: unknown, root: string): string[] => {
  const duplicates = field(report, 'duplicates');
  return (Array.isArray(duplicates) ? duplicates : []).map(
    (clone: unknown) =>
      `${String(field(clone, 'lines'))} lines: ${placeOf(field(clone, 'firstFile'), root)} and ${placeOf(field(clone, 'secondFile'), root)}`,
  );
};

/** The repo's jscpd, which must be the version every project measures with. */
const jscpdOf = (root: string): string => {
  const manifest = path.join(root, 'node_modules', 'jscpd', 'package.json');
  const version = existsSync(manifest)
    ? field(JSON.parse(readFileSync(manifest, 'utf8')), 'version')
    : undefined;
  if (version !== JSCPD_VERSION) {
    throw new Error(
      `kit-duplicates measures with jscpd ${JSCPD_VERSION}, a devDependency of the repo`,
    );
  }
  return path.join(root, 'node_modules', '.bin', 'jscpd');
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { format: { type: 'string', default: FORMATS } },
    allowPositionals: true,
  });
  const root = process.cwd();
  const output = mkdtempSync(path.join(tmpdir(), 'kit-duplicates-'));
  try {
    const folders = positionals.length === 0 ? ['.'] : positionals;
    execFileSync(jscpdOf(root), jscpdArguments(values.format, output, folders), {
      stdio: 'ignore',
    });
    const report: unknown = JSON.parse(
      readFileSync(path.join(output, 'jscpd-report.json'), 'utf8'),
    );
    const clones = clonesIn(report, root);
    for (const clone of clones) {
      console.error(clone);
    }
    if (clones.length > 0) {
      process.exitCode = 1;
    } else {
      console.log(`kit-duplicates: no block over 10 lines repeats in ${folders.join(', ')}`);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
