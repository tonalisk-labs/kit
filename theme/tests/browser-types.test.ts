// What a site's browser code imports from the theme reaches no Node type. Sites check their pages'
// scripts without Node's globals, and a declaration here that pulled Node's in, as Astro's and
// Starlight's do, would hand those globals back to every script that imports the theme.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

/** TypeScript's own compiler, by the binary its manifest names: the package exports no path to it. */
const MANIFEST = createRequire(import.meta.url).resolve('typescript/package.json');
const TSC = path.join(path.dirname(MANIFEST), 'bin', 'tsc');
const PROJECT = path.join(import.meta.dirname, 'fixtures', 'browser-tsconfig.json');

await test('the theme’s entry, checked as browser code, reaches none of Node’s types', () => {
  const files = execFileSync(process.execPath, [TSC, '--listFilesOnly', '-p', PROJECT], {
    encoding: 'utf8',
  }).split('\n');
  assert.deepEqual(
    files.filter((file) => file.includes(`${path.sep}@types${path.sep}node${path.sep}`)),
    [],
  );
});
