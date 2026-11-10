// A site's own @theme, after kit's stylesheet, gives a semantic scale its own colours, such as its
// Apple app's accent: the utilities then paint them, and every step it leaves keeps kit's alias.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { compile } from '@tailwindcss/node';

await test("a site's @theme re-points a semantic step, and leaves the rest kit's", async () => {
  const site = ["@import './index.css';", '@theme {', '  --color-primary-600: #004a9e;', '}'];
  const read: string[] = [];
  const compiler = await compile(site.join('\n'), {
    base: path.join(import.meta.dirname, '..'),
    onDependency: (file) => {
      read.push(path.basename(file));
    },
  });
  assert.ok(read.includes('theme.css'), read.join(', '));
  const css = compiler.build(['bg-primary-600', 'text-primary-500']);
  assert.match(css, /--color-primary-600: #004a9e;/u);
  assert.match(css, /--color-primary-500: var\(--color-indigo-500\);/u);
  assert.match(css, /\.bg-primary-600 \{\s*background-color: var\(--color-primary-600\);/u);
});
