// Kotlin is held to kit's rules by detekt with every rule on: code at each elite limit passes, and
// code one past each fails for that limit alone. ktlint, with kit's editorconfig, passes both.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const KIT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(import.meta.dirname, 'fixtures/kotlin');

/** The JVM the tools run on, told that its compiler's use of sun.misc.Unsafe is expected, and
 *  with none of the machine's own JVM options, which a JVM announces on every start. */
const jvm: NodeJS.ProcessEnv = Object.assign(
  Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'JAVA_TOOL_OPTIONS')),
  { JAVA_OPTS: '--sun-misc-unsafe-memory-access=allow' },
);

/** The run of detekt over a fixture folder: its exit status and the rules it reported, sorted. */
const detekt = (folder: string): { status: number | null; rules: string[] } => {
  const run = spawnSync(
    'detekt-cli',
    [
      '--all-rules',
      '--config',
      `${KIT}/rules/detekt.yml,${KIT}/rules/detekt-elite.yml`,
      '--input',
      path.join(FIXTURES, folder),
    ],
    { encoding: 'utf8', env: jvm },
  );
  const rules = [...run.stdout.matchAll(/^\S+\.kt:\d+:\d+: .* \[(?<rule>\w+)\]$/gmu)].map(
    ({ groups }) => (groups === undefined ? '' : String(groups['rule'])),
  );
  return { status: run.status, rules: rules.toSorted() };
};

await test('code at each elite limit passes every detekt rule', () => {
  assert.deepEqual(detekt('meets'), { status: 0, rules: [] });
});

await test("a test suite's tests are named as the sentences they prove", () => {
  assert.deepEqual(detekt('suites'), { status: 0, rules: [] });
});

await test('code one past each elite limit fails for that limit alone', () => {
  assert.deepEqual(detekt('exceeds'), {
    status: 2,
    rules: ['CognitiveComplexMethod', 'CyclomaticComplexMethod', 'LongMethod', 'NestedBlockDepth'],
  });
});

await test("ktlint, with kit's editorconfig, finds nothing in any fixture", () => {
  const run = spawnSync(
    'ktlint',
    [`--editorconfig=${KIT}/rules/ktlint.editorconfig`, `${FIXTURES}/**/*.kt`],
    { encoding: 'utf8', env: jvm },
  );
  assert.equal(run.stdout + run.stderr, '');
  assert.equal(run.status, 0);
});
