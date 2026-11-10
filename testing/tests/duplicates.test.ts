// The duplication check measures as every project does, and names each clone by both its places.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clonesIn, FORMATS, jscpdArguments } from '../../rules/duplicates.ts';

await test("jscpd runs with every project's flags, on the folders named", () => {
  assert.deepEqual(
    jscpdArguments(FORMATS, '/out', ['web', 'apple']).join(' '),
    [
      '--min-lines 11 --format typescript,tsx,javascript,swift,rust --cross-formats js-ts',
      '--workers 3 --absolute --reporters json,silent --output /out --no-tips --no-colors web apple',
    ].join(' '),
  );
});

await test('each clone in a report is one line, its places relative to the repo', () => {
  const clone = {
    lines: 13,
    firstFile: { name: '/repo/a/one.ts', start: 51, end: 63 },
    secondFile: { name: '/repo/b/two.ts', start: 188, end: 200 },
  };
  assert.deepEqual(clonesIn({ duplicates: [clone] }, '/repo'), [
    '13 lines: a/one.ts:51-63 and b/two.ts:188-200',
  ]);
  assert.deepEqual(clonesIn({ duplicates: [] }, '/repo'), []);
  assert.deepEqual(clonesIn({}, '/repo'), []);
});
