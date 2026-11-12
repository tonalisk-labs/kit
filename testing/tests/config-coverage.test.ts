import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claimsIn } from '../src/config-coverage.ts';

await test('a header claims the keys on its own line, from line and block comments alike', () => {
  const source = [
    '/**',
    ' * Covers: limits.max_open_notes, limits.share.editors.',
    ' */',
    '\t// Covers: sessions.idle_minutes',
    '\t*\tCovers:\tclient.pull_open_concurrency',
  ].join('\n');
  assert.deepEqual(claimsIn(source), [
    'limits.max_open_notes',
    'limits.share.editors',
    'sessions.idle_minutes',
    'client.pull_open_concurrency',
  ]);
});

await test('a header with no keys claims none, and never the next line', () => {
  assert.deepEqual(claimsIn('// Covers:\nconst limit = 1;\n'), []);
  assert.deepEqual(claimsIn(' * Covers:\n * limits.max_open_notes\n'), []);
  assert.deepEqual(claimsIn(`// Covers:${' '.repeat(8)}\n\nlimits.max_open_notes\n`), []);
});

await test('a header names its marker and its word on one line', () => {
  assert.deepEqual(claimsIn('//\nCovers: limits.max_open_notes\n'), []);
  assert.deepEqual(claimsIn('\n\n   \n// Covers: limits.max_open_notes\n'), [
    'limits.max_open_notes',
  ]);
});
