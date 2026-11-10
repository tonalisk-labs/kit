// What a built page makes a visitor download: its eager scripts follow every static import, an
// island that waits and a dynamic import count as later, and each is measured as brotli bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { brotliCompressSync, constants } from 'node:zlib';

import {
  type Build,
  hashedNames,
  hashFree,
  overBudget,
  pathFree,
  sizeOf,
} from '../src/checks/size.ts';

const encoder = new TextEncoder();

/** A build of the given files, by path from its root. */
const buildOf = (files: Readonly<Record<string, string>>): Build =>
  new Map(Object.entries(files).map(([file, text]) => [file, encoder.encode(text)]));

const brotli = (text: string): number =>
  brotliCompressSync(encoder.encode(text), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;

const FILES: Readonly<Record<string, string>> = {
  'index.html': [
    '<link rel="stylesheet" href="/_astro/page.css">',
    '<script type="module" src="/_astro/entry.js"></script>',
    '<astro-island client="load" component-url="/_astro/app.js"></astro-island>',
    '<astro-island client="visible" component-url="/_astro/footer.js"></astro-island>',
  ].join(''),
  '_astro/page.css': 'body{margin:0}',
  '_astro/entry.js': 'import{a}from"./shared.js";a();',
  '_astro/app.js': 'import"./shared.js";export*from"./react.js";const l=()=>import("./editor.js");',
  '_astro/shared.js': 'export const a=()=>1;',
  '_astro/react.js': 'export const r=2;',
  '_astro/editor.js': 'import"./codemirror.js";new Worker(new URL("./scan.js",import.meta.url));',
  '_astro/codemirror.js': 'export const c=3;',
  '_astro/scan.js': 'fetch(new URL("./reader.wasm",import.meta.url));',
  '_astro/footer.js': 'export const f=4;',
  '_astro/reader.wasm': '\u0000asm',
  '_astro/unused.js': 'export const u=5;',
};

await test('a page’s eager scripts are its entries and all they import at once', () => {
  const [page] = sizeOf(buildOf(FILES)).pages;
  const eager = ['entry.js', 'app.js', 'shared.js', 'react.js'];
  assert.deepEqual(page, {
    page: 'index.html',
    eager: eager.reduce((sum, file) => sum + brotli(FILES[`_astro/${file}`] ?? ''), 0),
    css: brotli(FILES['_astro/page.css'] ?? ''),
  });
});

await test('what loads later is a waiting island and what a dynamic import or worker reaches', () => {
  const size = sizeOf(buildOf(FILES));
  const later = ['editor.js', 'codemirror.js', 'scan.js', 'footer.js'];
  assert.equal(
    size.lazy,
    later.reduce((sum, file) => sum + brotli(FILES[`_astro/${file}`] ?? ''), 0),
  );
  assert.equal(size.wasm, brotli(FILES['_astro/reader.wasm'] ?? ''));
});

await test('a dynamic import and a worker named in backticks, as Vite writes them, load later', () => {
  const files: Readonly<Record<string, string>> = {
    'index.html': '<script type="module" src="/_astro/entry.js"></script>',
    '_astro/entry.js': [
      'const w=()=>import(`./workspace.js`);',
      'new Worker(new URL(`/_astro/scan-worker.js`,import.meta.url));',
      `const l=n=>import(\`./locale/\${n}.js\`);`,
    ].join(''),
    '_astro/workspace.js': 'import"./codemirror.js";export const w=1;',
    '_astro/codemirror.js': 'export const c=3;',
    '_astro/scan-worker.js': 'fetch(new URL(`/_astro/reader.wasm`,import.meta.url));',
    '_astro/reader.wasm': '\u0000asm',
    '_astro/locale/en.js': 'export const e=4;',
  };
  const later = ['workspace.js', 'codemirror.js', 'scan-worker.js'];
  assert.equal(
    sizeOf(buildOf(files)).lazy,
    later.reduce((sum, file) => sum + brotli(files[`_astro/${file}`] ?? ''), 0),
  );
});

await test('each budget a site exceeds is named, with the page that exceeds it', () => {
  const size = sizeOf(buildOf(FILES));
  const [page = { eager: 0 }] = size.pages;
  const roomy = { eager: 1e6, css: 1e6, lazy: 1e6, wasm: 1e6 };
  assert.deepEqual(overBudget(size, roomy), []);
  const tight = { eager: 1, css: 1e6, lazy: 1e6, wasm: 1 };
  assert.deepEqual(overBudget(size, tight), [
    `index.html: eager scripts ${String(page.eager)} B, over 1 B`,
    `wasm ${String(size.wasm)} B, over 1 B`,
  ]);
});

await test('an inline module’s imports are eager, and a chunk shared by two pages counts on each', () => {
  const files = {
    'a/index.html': '<script type="module">import "/_astro/boot.js";</script>',
    'b.html': '<script type="module">import { go } from "../_astro/boot.js"; go();</script>',
    '_astro/boot.js': 'export const go=()=>1;',
  };
  const { pages } = sizeOf(buildOf(files));
  const boot = brotli(files['_astro/boot.js']);
  assert.deepEqual(
    pages.map(({ page, eager }) => [page, eager]),
    [
      ['a/index.html', boot],
      ['b.html', boot],
    ],
  );
});

await test('what a page or chunk names outside the site, or that the build lacks, counts nowhere', () => {
  const files = {
    'index.html': [
      '<script src="https://js.stripe.com/v3/"></script>',
      '<script type="module" src="/_astro/entry.js"></script>',
      '<link rel="stylesheet" href="/_astro/missing.css">',
      '<astro-island client="idle"></astro-island>',
    ].join(''),
    '_astro/entry.js': 'import"https://cdn.test/x.js";import"./gone.js";const s="./style.css";',
    '_astro/style.css': 'a{color:red}',
  };
  const size = sizeOf(buildOf(files));
  assert.deepEqual(size.pages, [
    { page: 'index.html', eager: brotli(files['_astro/entry.js']), css: 0 },
  ]);
  assert.deepEqual([size.lazy, size.wasm], [0, 0]);
});

await test('stylesheets and what loads later are each held to their own budget', () => {
  const size = sizeOf(buildOf(FILES));
  const [page = { css: 0 }] = size.pages;
  const tight = { eager: 1e6, css: 1, lazy: 1, wasm: 1e6 };
  assert.deepEqual(overBudget(size, tight), [
    `index.html: stylesheets ${String(page.css)} B, over 1 B`,
    `later scripts ${String(size.lazy)} B, over 1 B`,
  ]);
});

/** A Starlight-like stylesheet as a checkout at `path` builds it: each scoped name a hash of the
 *  component's absolute path, as Astro names one outside its root. */
const scopedAt = (path: string): string => {
  const hash = (component: string): string =>
    createHash('sha256')
      .update(`${path}/node_modules/${component}.astro`)
      .digest('hex')
      .slice(0, 8);
  return ['Banner', 'Header', 'Sidebar', 'Footer', 'Search']
    .map(
      (component) =>
        `.sl-${component.toLowerCase()}:where(.astro-${hash(component)}){padding:1rem}` +
        `[data-astro-cid-${hash(component)}]{display:flex}`,
    )
    .join('');
};

await test('a stylesheet weighs the same from any checkout, its scoped names kept distinct', () => {
  const css = (path: string): number => {
    const build = buildOf({
      'index.html': '<link rel="stylesheet" href="/_astro/page.css">',
      '_astro/page.css': scopedAt(path),
    });
    const [page = { css: 0 }] = sizeOf(build).pages;
    return page.css;
  };
  const here = css('/Users/someone/code/site');
  assert.notEqual(scopedAt('/Users/someone/code/site'), scopedAt('/home/runner/work/site/site'));
  assert.equal(css('/home/runner/work/site/site'), here);
  assert.equal(css('/tmp/x'), here);
  assert.equal(
    pathFree('.a:where(.astro-abcd1234){} [data-astro-cid-abcd1234] .astro-0000ffff{}'),
    '.a:where(.astro-00000000){} [data-astro-cid-00000000] .astro-00000001{}',
  );
  assert.equal(pathFree('.astro-banner-box{} .astronaut{}'), '.astro-banner-box{} .astronaut{}');
});

/** A page whose one eager chunk imports a shared chunk now and the chunk at `later` later, each
 *  named by its content hash as Vite names it. */
const namingLater = (later: string): Readonly<Record<string, string>> => ({
  'index.html': '<script type="module" src="/_astro/entry.Dqn7M9-M.js"></script>',
  '_astro/entry.Dqn7M9-M.js': `import{a}from"./shared.CCLPBcFM.js";a();const later=()=>import("./${later}");export const entry=later;`,
  '_astro/shared.CCLPBcFM.js': 'export const a=()=>1;',
  [`_astro/${later}`]: 'export const b=2;',
});

/** The eager weight of `namingLater`'s page. */
const eagerNaming = (later: string): number => {
  const [page = { eager: 0 }] = sizeOf(buildOf(namingLater(later))).pages;
  return page.eager;
};

/** `namingLater`'s eager chunk, as built. */
const entryNaming = (later: string): string => namingLater(later)['_astro/entry.Dqn7M9-M.js'] ?? '';

await test('a chunk weighs the same whatever the hashes of the chunks it names became', () => {
  // A later chunk's change renames it, and so the chunk that names it: as built, the two compress
  // twenty bytes apart.
  assert.notEqual(
    brotli(entryNaming('later.aaaaaaaa.js')),
    brotli(entryNaming('later.BSPS7ISR.js')),
  );
  assert.equal(eagerNaming('later.aaaaaaaa.js'), eagerNaming('later.BSPS7ISR.js'));
  assert.equal(eagerNaming('later-aaaaaaaa.js'), eagerNaming('later-BSPS7ISR.js'));
});

await test('each hashed name of the build is numbered where it first appears, and no other name', () => {
  const names = hashedNames(
    buildOf({
      '_astro/client.Dqn7M9-M.js': '',
      '_astro/client.CCLPBcFM.js': '',
      '_astro/scan-worker-BskI6fuR.js': '',
      '_astro/fonts/body.k2_Qw-8Z.woff2': '',
      '_astro/shared.js': '',
    }),
  );
  assert.equal(
    hashFree(
      [
        'import"./client.CCLPBcFM.js";import"./client.Dqn7M9-M.js";',
        'new Worker("/_astro/scan-worker-BskI6fuR.js");import"./client.CCLPBcFM.js";',
        'import"./shared.js";import"./other.ABCDEFGH.js";',
      ].join(''),
      names,
    ),
    [
      'import"./client.00000000.js";import"./client.00000001.js";',
      'new Worker("/_astro/scan-worker-00000002.js");import"./client.00000000.js";',
      'import"./shared.js";import"./other.ABCDEFGH.js";',
    ].join(''),
  );
  assert.equal(
    hashFree('@font-face{src:url(/_astro/fonts/body.k2_Qw-8Z.woff2)}', names),
    '@font-face{src:url(/_astro/fonts/body.00000000.woff2)}',
  );
  assert.equal(hashedNames(buildOf({ 'index.html': '', '_astro/entry.js': '' })), undefined);
  assert.equal(hashFree('import"./entry.js";'), 'import"./entry.js";');
});
