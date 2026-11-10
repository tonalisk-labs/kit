import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StarlightRouteData } from '@astrojs/starlight/route-data';

import { jsonLdHead, jsonLdScript } from '../json-ld.ts';
import { settleHead } from '../starlight/head.ts';

const HOSTILE = '</script><script>alert(1)</script><!-- </SCRIPT >';

const graph = {
  '@context': 'https://schema.org' as const,
  '@graph': [{ '@type': 'Thing' as const, name: HOSTILE }],
};

await test('a </script> inside a value cannot close the element, and the value survives', () => {
  const text = jsonLdScript(graph);
  // The script element's text ends only at `</script`, which needs a `<`.
  assert.equal(text.includes('<'), false);
  assert.deepEqual(JSON.parse(text), graph);
});

await test('a Starlight head entry is a JSON-LD script holding the same safe text', () => {
  // Typed as Starlight's own entry: the type checker holds the theme's spelled-out one to it.
  const entry: StarlightRouteData['head'][number] = jsonLdHead(graph);
  assert.deepEqual(entry, {
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    content: jsonLdScript(graph),
  });
});

await test('Starlight’s route data is what the head is settled on', () => {
  const route: Pick<StarlightRouteData, 'head'> = {
    head: [
      { tag: 'meta', attrs: { property: 'og:locale', content: 'en-GB' } },
      { tag: 'meta', attrs: { name: 'robots', content: 'noindex' } },
      { tag: 'link', attrs: { rel: 'canonical', href: 'https://example.com/404' } },
    ],
  };
  settleHead(route);
  assert.deepEqual(
    route.head.map(({ attrs }) => attrs),
    [
      { property: 'og:locale', content: 'en_GB' },
      { name: 'robots', content: 'noindex' },
    ],
  );
});
