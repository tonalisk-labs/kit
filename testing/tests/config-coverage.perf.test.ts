// Run alone and uninstrumented, its budget in CPU time, as every timed test is.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claimsIn } from '../src/config-coverage.ts';
import { cpuClock } from './cpu.ts';

/** Sources a pattern with overlapping blanks reads in quadratic time: 200,000 blank lines took the
 *  old one some 20 s of CPU. */
const SOURCES: Readonly<Record<string, string>> = {
  'blank lines': '\n'.repeat(200_000),
  'blank lines of spaces': ' \n'.repeat(200_000),
  'a header of spaces only': `*Covers:${' '.repeat(200_000)}`,
  'headers of spaces only': `*Covers:${' '.repeat(20)}\n`.repeat(20_000),
};

await test('sources of blanks claim nothing, each read in linear time', () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    const spent = cpuClock();
    assert.deepEqual(claimsIn(source), [], name);
    const took = spent();
    assert.ok(took < 100, `${name}: ${String(Math.round(took))} ms of CPU`);
  }
});
