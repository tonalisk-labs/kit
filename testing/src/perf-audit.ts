#!/usr/bin/env node
// The release audit (perf/audit.ts) over a run's readings, each held to its budget and, given
// `--last` the last release's readings, to them. Any failure exits 1.
//   kit-perf-audit readings.json [--last last-release.json]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { audit, type Readings, readingsFrom, report } from './perf/audit.ts';

const USAGE = 'usage: kit-perf-audit readings.json [--last last-release.json]';
const { values, positionals } = parseArgs({
  options: { last: { type: 'string' } },
  allowPositionals: true,
});
const [file, ...more] = positionals;
if (file === undefined || more.length > 0) {
  throw new Error(more.length > 0 ? `${USAGE}: the last release's readings follow --last` : USAGE);
}
const read = (source: string): Readings => readingsFrom(readFileSync(source, 'utf8'), source);
const now = read(file);
const last = values.last === undefined ? undefined : read(values.last);
const verdicts = audit(now, last);
console.log(report(verdicts, now, last).join('\n'));
const said = verdicts.flatMap((verdict) => (verdict.said === undefined ? [] : [verdict.said]));
process.exitCode = said.some(({ failed }) => failed) ? 1 : 0;
