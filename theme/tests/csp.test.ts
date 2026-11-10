import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { starlightCsp } from '../starlight/csp.ts';

type Hash = `sha256-${string}`;

const sha256 = (text: string): Hash =>
  `sha256-${createHash('sha256').update(text).digest('base64')}`;

/** The hashes a CSP allows for styles: element hashes as they are, attribute ones unwrapped. */
const styleHashes = (csp: ReturnType<typeof starlightCsp>): string[] =>
  (csp.styleDirective === undefined ? [] : (csp.styleDirective.hashes ?? [])).map((entry) =>
    typeof entry === 'string' ? entry : entry.hash,
  );

await test('engravings give one hash per distinct style element and style attribute', () => {
  const hashes = styleHashes(starlightCsp({ engravings: new URL('fixtures/', import.meta.url) }));
  const elements = new Set(hashes.slice(0, 2));
  assert.ok(elements.has(sha256('.a{fill:red}')));
  assert.ok(elements.has(sha256('.b{stroke:green}')));
  const attributes = hashes.slice(2);
  assert.equal(new Set(attributes).size, attributes.length);
  assert.ok(attributes.includes(sha256('fill: blue')));
  assert.ok(attributes.includes(sha256('display: none;')));
});

await test('without engravings only Starlight styles and scripts are hashed', () => {
  const csp = starlightCsp({ tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 } });
  assert.ok(styleHashes(csp).includes(sha256('--depth: 1;')));
  const scripts = csp.scriptDirective === undefined ? [] : (csp.scriptDirective.hashes ?? []);
  assert.ok(scripts.length > 0);
});

const framing = (frames?: readonly string[]): string[] =>
  (starlightCsp(frames === undefined ? {} : { frames }).directives ?? []).filter((directive) =>
    directive.startsWith('frame-src'),
  );

await test('frames replace the site as the one source of frames', () => {
  assert.deepEqual(framing(), []);
  assert.deepEqual(framing(['https://a.example', 'https://b.example']), [
    'frame-src https://a.example https://b.example',
  ]);
});
