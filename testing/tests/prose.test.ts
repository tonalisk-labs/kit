// A function or type holds at most 2 comment lines, its doc and its body's comments together, in
// every language kit-prose reads; a Markdown file holds at most 30 lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commentFindings, markdownFindings } from '../../rules/prose.ts';

const lines = (...text: string[]): string => text.join('\n');

/** A page of `count` lines. */
const page = (count: number): string => Array.from({ length: count }, () => 'A line.').join('\n');

await test("a function's doc and the comments in its body count together, its delimiters not", () => {
  const twoAndOne = lines(
    '/** One. */',
    '// Two.',
    'export const f = async (',
    '  a: number,',
    '): Promise<void> => {',
    '  if (a > 0) {',
    '    // Three, in the if, for the function.',
    '  }',
    '};',
  );
  assert.deepEqual(commentFindings('f.ts', 'ts', twoAndOne), [
    'f.ts:1 has 3 comment lines, where the most is 2',
  ]);
  const expanded = lines('/**', ' * One.', ' * Two.', ' */', 'const g = (): void => {', '};');
  assert.deepEqual(commentFindings('g.ts', 'ts', expanded), []);
});

await test("each member's doc is its own, and a file's header is the file's", () => {
  const members = lines(
    '// The file, said in three lines,',
    '// as a header may be,',
    '// before its imports.',
    "import { x } from 'y';",
    '',
    '/** A type. */',
    'interface T {',
    '  /** One, and',
    '   *  two. */',
    '  readonly a: string;',
    '  /** Its own. */',
    '  readonly b: number;',
    '}',
  );
  assert.deepEqual(commentFindings('t.ts', 'ts', members), []);
});

await test('Swift, Rust and shell count their own comments, and Python its docstrings', () => {
  const swift = lines('/// One.', '/// Two.', 'func f() {', '    // Three.', '}');
  assert.deepEqual(commentFindings('f.swift', 'swift', swift), [
    'f.swift:1 has 3 comment lines, where the most is 2',
  ]);
  const rust = lines('/// One.', 'fn f() {', '    // Two.', '}', '/// Three.', 'struct S;');
  assert.deepEqual(commentFindings('f.rs', 'rs', rust), []);
  const shell = lines('#!/bin/sh', '# One.', 'f() {', '  # Two.', '  # Three.', '}');
  assert.deepEqual(commentFindings('f.sh', 'sh', shell), [
    'f.sh:2 has 3 comment lines, where the most is 2',
  ]);
  const python = lines(
    'class C:',
    '    """One."""',
    '',
    '    def f(self):',
    '        """Two,',
    '        and three."""',
    '        # Four.',
    '        return 1',
  );
  assert.deepEqual(commentFindings('c.py', 'py', python), [
    'c.py:4 has 3 comment lines, where the most is 2',
  ]);
});

await test('a line that says nothing to a reader counts for nothing, in every language', () => {
  const python = lines(
    'def f():',
    '    """One.',
    '',
    '    Two, after the blank line Ruff asks for.',
    '    """',
    '    return 1',
  );
  assert.deepEqual(commentFindings('f.py', 'py', python), []);
  const rust = lines('/// One.', '///', '/// # Errors', '///', '/// Two.', 'fn f() {', '}');
  assert.deepEqual(commentFindings('f.rs', 'rs', rust), []);
  const header = [
    '# The file, said in three lines,',
    '# as a header may be,',
    '# before its code.',
  ];
  const shell = lines(
    '#!/bin/sh',
    ...header,
    '',
    '# One.',
    'f() {',
    '  # shellcheck disable=SC2086',
    '  # Two.',
    '}',
  );
  assert.deepEqual(commentFindings('f.sh', 'sh', shell), []);
  const swift = lines(
    ...header.map((line) => line.replace('#', '//')),
    '@preconcurrency internal import Foundation',
    '',
    '/// One.',
    'func f() {',
    '    // swiftlint:disable:next force_unwrapping',
    '    // Two.',
    '}',
  );
  assert.deepEqual(commentFindings('f.swift', 'swift', swift), []);
});

await test('a type tag that only restates the type, or a tool’s directive, counts for nothing', () => {
  const typed = ['/**', ' * One.', ' * @param {string} name', ' * @returns {number}', ' */'];
  const javascript = lines(...typed, 'export function f(name) {', '  return name.length;', '}');
  assert.deepEqual(commentFindings('f.mjs', 'js', javascript), []);
  const directives = lines(
    '/** One. */',
    'export const f = (): void => {',
    '  // cspell:disable-next-line',
    '  // oxlint-disable-next-line no-console',
    '  # noqa: E501',
    '  // Two.',
    '};',
  );
  assert.deepEqual(commentFindings('f.ts', 'ts', directives), []);
});

await test('a type tag that says more than its type, or another heading, still counts', () => {
  const said = lines(
    '/** One.',
    ' * @param {string} name Two.',
    ' * @returns {number} Three. */',
    'function f(name) {',
    '}',
  );
  assert.deepEqual(commentFindings('f.mjs', 'js', said), [
    'f.mjs:1 has 3 comment lines, where the most is 2',
  ]);
  const rust = lines('/// One.', '/// # Examples', '/// Two.', 'fn f() {', '}');
  assert.deepEqual(commentFindings('f.rs', 'rs', rust), [
    'f.rs:1 has 3 comment lines, where the most is 2',
  ]);
});

await test('a Markdown file of 30 lines holds, and one of 31 does not', () => {
  assert.deepEqual(markdownFindings('a.md', `${page(30)}\n`), []);
  assert.deepEqual(markdownFindings('b.md', page(31)), ['b.md has 31 lines, where the most is 30']);
});
