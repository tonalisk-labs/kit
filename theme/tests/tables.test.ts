import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownToHtml } from 'satteri';

import { scrollableTables } from '../starlight/tables.ts';

const render = async (markdown: string): Promise<string> => {
  const { html } = await markdownToHtml(markdown, { hastPlugins: [scrollableTables('Tabela')] });
  return html;
};

const REGION = '<section data-table-scroll="" tabindex="0" aria-label=';

await test('each table is wrapped in a region named by its place and its headings', async () => {
  const html = await render(
    '| Harmónico | Frequência |\n| --- | --- |\n| 1 | 110 Hz |\n\nTexto.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  );
  assert.ok(html.includes(`${REGION}"Tabela 1: Harmónico, Frequência"><table>`), html);
  assert.ok(html.includes(`${REGION}"Tabela 2: a, b"><table>`), html);
  assert.equal(html.split('</table></section>').length, 3);
});

await test('a table without headings is named by its place alone', async () => {
  const html = await render('|   |\n| - |\n| 1 |\n');
  assert.ok(html.includes(`${REGION}"Tabela 1"><table>`), html);
});

await test('every page counts its tables from 1', async () => {
  const table = '| a |\n| - |\n| 1 |\n';
  const [first, second] = [await render(table), await render(table)];
  assert.ok(first.includes(`${REGION}"Tabela 1: a">`));
  assert.ok(second.includes(`${REGION}"Tabela 1: a">`));
});

await test('a page without tables is left as it is', async () => {
  assert.equal(await render('Texto.\n'), '<p>Texto.</p>\n');
});
