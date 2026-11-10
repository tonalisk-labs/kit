// The headers a production edge adds, by class: an answer takes each class its path names, in
// order, a later class's header in place of an earlier's, its names in lower case.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type EdgeHeaders, edgeHeadersFor } from '../src/adapter.ts';

const EDGE: EdgeHeaders = {
  classes: {
    every: { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
    worker: { 'Content-Security-Policy': "script-src 'self'" },
  },
  classesOf: (path) => (path.endsWith('worker.js') ? ['every', 'worker'] : ['every']),
};

await test('an answer takes every header of its classes, a later class’s in place', () => {
  assert.deepEqual(edgeHeadersFor(EDGE, '/'), {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  });
  assert.deepEqual(edgeHeadersFor(EDGE, '/_astro/worker.js'), {
    'content-security-policy': "script-src 'self'",
    'x-frame-options': 'DENY',
  });
});

await test('a class the adapter names but never defines is a broken adapter', () => {
  const broken: EdgeHeaders = { classes: EDGE.classes, classesOf: () => ['every', 'api'] };
  assert.throws(() => edgeHeadersFor(broken, '/api/'), /no class api/u);
});
