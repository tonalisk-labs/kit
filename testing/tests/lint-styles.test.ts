// A string is linted as a class list only when every word in it is a class, one Tailwind reads, a
// group or peer marker, or one the site's own stylesheets define, and one of them compiles: prose
// is left alone, however many of its words look like utilities, and a site's generated files
// aren't read at all. A stylesheet's raw colours are its own only as the semantic scales' values
// in @theme.
import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { classFindings, cssFindings, ownClasses, sourcesOf } from '../../rules/lint-styles.ts';

await test('prose is no class list, though "grow" compiles and "from" parses', () => {
  const copy = 'You can watch your tree grow as you write, from the toolbar.';
  assert.deepEqual(classFindings({ file: 'strings.ts' }, 1, copy), []);
});

await test('a class list with one class outside the theme still names it', () => {
  assert.deepEqual(classFindings({ file: 'view.tsx' }, 3, 'flex grow bg-brand'), [
    { file: 'view.tsx', line: 3, category: 'custom-token', text: 'bg-brand' },
  ]);
  assert.deepEqual(
    classFindings({ file: 'view.tsx' }, 4, 'group relative w-[13px]'),
    [{ file: 'view.tsx', line: 4, category: 'arbitrary', text: 'w-[13px]' }],
    'a group marker leaves a list a list',
  );
});

await test("a class list with one of the site's own classes is still read as one", () => {
  const own = new Set(ownClasses('.markdown { color: inherit; }'));
  assert.deepEqual(classFindings({ file: 'prose.astro', own }, 30, 'markdown mt-[13px]'), [
    { file: 'prose.astro', line: 30, category: 'arbitrary', text: 'mt-[13px]' },
  ]);
  assert.deepEqual(
    classFindings({ file: 'prose.astro' }, 30, 'markdown mt-[13px]'),
    [],
    'no class of its own, a word Tailwind can’t read is prose',
  );
});

await test("a stylesheet's own classes are its selectors' names, not its comments or numbers", () => {
  const css = '/* .note */ .splitter::-moz-range-thumb { width: 0.5rem; } .row > .cell:hover {}';
  assert.deepEqual(ownClasses(css).toSorted(), ['cell', 'row', 'splitter']);
});

await test("a site's @theme gives the semantic scales its own colours, and nothing else", () => {
  const css = [
    '@theme {',
    '  --color-primary-600: #004a9e;',
    '  --color-secondary-500: rgb(142 142 147);',
    '  --color-brand: #ff0000;',
    '  --color-accent-500: 4px;',
    '}',
    '.note { color: #004a9e; }',
  ].join('\n');
  assert.deepEqual(cssFindings({ file: 'global.css' }, css), [
    { file: 'global.css', line: 5, category: 'raw-css', text: '4px' },
    { file: 'global.css', line: 4, category: 'raw-css', text: '#ff0000' },
    { file: 'global.css', line: 7, category: 'raw-css', text: '#004a9e' },
    { file: 'global.css', line: 4, category: 'custom-token', text: '--color-brand:' },
  ]);
});

await test('a word that parses alone, with nothing that compiles, is no class list', () => {
  assert.deepEqual(classFindings({ file: 'kinds.ts' }, 1, 'from'), []);
});

await test("a site's generated files and type declarations are left out of the scan", async () => {
  await using folder = await mkdtempDisposable(path.join(tmpdir(), 'lint-styles-'));
  await mkdir(path.join(folder.path, 'src', 'lib'), { recursive: true });
  await Promise.all(
    ['src/view.tsx', 'src/lib/strings.gen.ts', 'src/env.d.ts'].map(async (file) =>
      writeFile(path.join(folder.path, file), ''),
    ),
  );
  assert.deepEqual(await sourcesOf('src', folder.path), ['src/view.tsx']);
});
