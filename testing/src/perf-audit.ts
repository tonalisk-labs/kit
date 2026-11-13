#!/usr/bin/env node
// The release audit (perf/audit.ts) over a run's readings, each held to its budget and, given
// `--last` the last release's readings, to them. Any failure exits 1.
//   kit-perf-audit readings.json [--last last-release.json]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { audit, type Readings, readingsOf, report } from './perf/audit.ts';

const { values, positionals } = parseArgs({
  options: { last: { type: 'string' } },
  allowPositionals: true,
});
const [file] = positionals;
if (file === undefined) {
  throw new Error('usage: kit-perf-audit readings.json [--last last-release.json]');
}
const read = (source: string): Readings =>
  readingsOf(JSON.parse(readFileSync(source, 'utf8')), source);
const now = read(file);
const last = values.last === undefined ? undefined : read(values.last);
const verdicts = audit(now, last);
console.log(report(verdicts, now, last).join('\n'));
process.exitCode = verdicts.some(({ failure }) => failure !== undefined) ? 1 : 0;
