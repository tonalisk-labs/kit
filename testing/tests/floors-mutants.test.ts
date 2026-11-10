// A file's mutation score is the share of its mutants the tests caught, a timeout among them; one
// that doesn't build counts for nothing. Each file mutated is held to its floor, or named.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judge, scoresOf } from '../src/floors/mutants.ts';

const outcome = (file: string, summary: string): unknown => ({
  scenario: { Mutant: { package: 'core', file, function: { function_name: 'f' } } },
  summary,
});

const outcomes = {
  outcomes: [
    { scenario: 'Baseline', summary: 'Success' },
    outcome('core/src/lib.rs', 'CaughtMutant'),
    outcome('core/src/lib.rs', 'CaughtMutant'),
    outcome('core/src/lib.rs', 'Timeout'),
    outcome('core/src/lib.rs', 'MissedMutant'),
    outcome('core/src/lib.rs', 'Unviable'),
    outcome('server/src/security.rs', 'MissedMutant'),
    outcome('server/src/security.rs', 'CaughtMutant'),
  ],
};

await test('each file scores what its tests caught of the mutants that built', () => {
  assert.deepEqual(
    [...scoresOf(outcomes)],
    [
      ['core/src/lib.rs', { caught: 3, tested: 4 }],
      ['server/src/security.rs', { caught: 1, tested: 2 }],
    ],
  );
});

await test('a file at its floor holds, one under it or with none fails, and a rise is named', () => {
  const scores = scoresOf(outcomes);
  const held = judge(
    scores,
    new Map<string, unknown>([
      ['core/src/lib.rs', 70],
      ['server/src/security.rs', 50],
    ]),
  );
  assert.ok(held.held);
  assert.deepEqual(held.lines, [
    'core/src/lib.rs: 3 of 4 mutants caught, 75.0%, floor 70%; raise its floor to 75',
    'server/src/security.rs: 1 of 2 mutants caught, 50.0%, floor 50%',
  ]);
  const under = judge(scores, new Map<string, unknown>([['core/src/lib.rs', 76]]));
  assert.ok(!under.held);
  assert.deepEqual(under.lines, [
    'core/src/lib.rs: 3 of 4 mutants caught, 75.0%, below its floor of 76%',
    'server/src/security.rs: 1 of 2 mutants caught, 50.0%; no floor in mutants.json: give it one, at most 50',
  ]);
});
