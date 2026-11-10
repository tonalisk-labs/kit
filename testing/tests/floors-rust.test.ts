// A crate's lines, regions and functions are those of the files in its folder and in no crate
// nested there, as cargo llvm-cov's summary counts them; a crate whose files no test ran has none.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coverageByCrate } from '../src/floors/rust.ts';

/** A file's summary, its regions twice its lines and its functions a tenth. */
const file = (filename: string, covered: number, count: number): unknown => ({
  filename,
  summary: {
    lines: { covered, count },
    regions: { covered: covered * 2, count: count * 2 },
    functions: { covered: Math.floor(covered / 10), count: Math.floor(count / 10) },
  },
});

const tally = (covered: number, count: number): unknown => ({ covered, count });

await test("each crate counts its own files' lines, regions and functions, a nested crate's apart", () => {
  const report = {
    data: [
      {
        files: [
          file('/w/model/src/lib.rs', 90, 100),
          file('/w/model/src/screen.rs', 5, 10),
          file('/w/ffi/src/lib.rs', 40, 50),
          file('/w/ffi/fuzz/src/run.rs', 1, 2),
          file('/w/model-extra/src/lib.rs', 3, 3),
        ],
      },
    ],
  };
  const crates = [
    { name: 'ffi', folder: '/w/ffi' },
    { name: 'fuzz', folder: '/w/ffi/fuzz' },
    { name: 'model', folder: '/w/model' },
    { name: 'idle', folder: '/w/idle' },
  ];
  assert.deepEqual(
    [...coverageByCrate(report, crates)],
    [
      ['ffi', { lines: tally(40, 50), regions: tally(80, 100), functions: tally(4, 5) }],
      ['fuzz', { lines: tally(1, 2), regions: tally(2, 4), functions: tally(0, 0) }],
      ['model', { lines: tally(95, 110), regions: tally(190, 220), functions: tally(9, 11) }],
    ],
  );
});

await test('a summary without a metric counts none of it', () => {
  const report = { data: [{ files: [{ filename: '/w/a/src/lib.rs', summary: {} }] }] };
  const none = tally(0, 0);
  assert.deepEqual(
    [...coverageByCrate(report, [{ name: 'a', folder: '/w/a' }])],
    [['a', { lines: none, regions: none, functions: none }]],
  );
});
