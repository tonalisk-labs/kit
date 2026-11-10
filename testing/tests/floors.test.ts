import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judge, type Measured, type Tally } from '../src/floors/hold.ts';

const counted: Tally = { covered: 876, count: 1000 };
const measured: Measured = { lines: counted, branches: { covered: 50, count: 100 } };

await test('a package at or above both floors holds, and a floor a point under is named', () => {
  const { lines, held } = judge(
    'pkg',
    measured,
    new Map([
      ['lines', 86],
      ['branches', 50],
    ]),
  );
  assert.ok(held);
  assert.deepEqual(lines, [
    'pkg: lines 87.6% of 1000, floor 86%; raise its floor to 87',
    'pkg: branches 50.0% of 100, floor 50%',
  ]);
});

await test('a share under its floor fails', () => {
  const { lines, held } = judge(
    'pkg',
    measured,
    new Map([
      ['lines', 87],
      ['branches', 51],
    ]),
  );
  assert.ok(!held);
  assert.equal(lines[1], 'pkg: branches 50.0% of 100, below its floor of 51%');
});

await test('a missing floor fails, naming the most it may be', () => {
  const { lines, held } = judge('pkg', measured, new Map([['lines', 87]]));
  assert.ok(!held);
  assert.equal(
    lines[1],
    'pkg: branches 50.0% of 100; no floor in coverage.json: give it one, at most 50',
  );
});

await test('no branches at all is full coverage', () => {
  const none: Measured = { lines: counted, branches: { covered: 0, count: 0 } };
  const { held } = judge(
    'pkg',
    none,
    new Map([
      ['lines', 87],
      ['branches', 100],
    ]),
  );
  assert.ok(held);
});

await test('a package measuring lines alone is held by its line floor alone', () => {
  const { lines, held } = judge('crate', { lines: counted }, new Map([['lines', 87]]));
  assert.ok(held);
  assert.deepEqual(lines, ['crate: lines 87.6% of 1000, floor 87%']);
});

await test("a Rust crate's regions and functions are held as its lines are", () => {
  const rust: Measured = {
    lines: counted,
    regions: { covered: 80, count: 100 },
    functions: { covered: 9, count: 10 },
  };
  const { lines, held } = judge(
    'crate',
    rust,
    new Map([
      ['lines', 87],
      ['regions', 81],
      ['functions', 90],
    ]),
  );
  assert.ok(!held);
  assert.deepEqual(lines, [
    'crate: lines 87.6% of 1000, floor 87%',
    'crate: regions 80.0% of 100, below its floor of 81%',
    'crate: functions 90.0% of 10, floor 90%',
  ]);
});
