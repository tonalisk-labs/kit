// Starlight scrolls a wide table sideways, and a table cannot take focus as a scroller should: each
// is wrapped in a named region a keyboard reaches, which scrolls instead (starlight.css).
import type { ElementContent, Element as HastElement } from 'hast';
import {
  defineHastPlugin,
  type HastPluginDefinition,
  type HastPluginEntry,
  type HastVisitorContext,
} from 'satteri';

const elements = (children: readonly ElementContent[]): HastElement[] =>
  children.filter((child): child is HastElement => child.type === 'element');

/** A table's headings: the header cells of its first row, through its `thead` or `tbody`, as text. */
const headingsOf = (table: HastElement, ctx: HastVisitorContext): string[] => {
  const sections = elements(table.children);
  return [sections, sections.flatMap((section) => elements(section.children))]
    .flat()
    .filter((row) => row.tagName === 'tr')
    .slice(0, 1)
    .flatMap((row) => elements(row.children))
    .filter((cell) => cell.tagName === 'th')
    .map((cell) => ctx.textContent(cell).trim())
    .filter((text) => text !== '');
};

/** Wraps each table of a page in a focusable region named in the page's language: `word` is
 *  "Table" in its language, numbered from 1 per page so no two regions share a name. */
export const scrollableTables =
  (word: string): HastPluginEntry =>
  (): HastPluginDefinition => {
    let place = 0;
    return defineHastPlugin({
      name: 'scrollable-tables',
      element: {
        filter: ['table'],
        visit(table, ctx) {
          place += 1;
          ctx.wrapNode(table, {
            type: 'element',
            tagName: 'section',
            properties: {
              dataTableScroll: '',
              tabIndex: 0,
              ariaLabel: [`${word} ${String(place)}`, headingsOf(table, ctx).join(', ')]
                .filter((part) => part !== '')
                .join(': '),
            },
            children: [],
          });
        },
      },
    });
  };
