// What every Starlight site's route middleware does to the head once its own entries are in.

/** A head entry as Starlight's route data holds one, spelled out rather than taken from Starlight,
 *  whose types reach Node's through Astro's: a site's browser code imports the theme too. */
interface HeadEntry {
  readonly attrs?: Record<string, string | boolean | undefined> | undefined;
}

const unindexed = (head: readonly HeadEntry[]): boolean =>
  head.some(
    ({ attrs = {} }) =>
      attrs['name'] === 'robots' &&
      typeof attrs['content'] === 'string' &&
      attrs['content'].includes('noindex'),
  );

/** Open Graph's locale as language_TERRITORY, not Starlight's BCP 47 tag; and no canonical
 *  address on a page kept out of the index, such as the 404 page. */
export const settleHead = (route: { head: HeadEntry[] }): void => {
  for (const { attrs = {} } of route.head) {
    if (attrs['property'] === 'og:locale' && typeof attrs['content'] === 'string') {
      attrs['content'] = attrs['content'].replace('-', '_');
    }
  }
  if (unindexed(route.head)) {
    route.head = route.head.filter(({ attrs = {} }) => attrs['rel'] !== 'canonical');
  }
};
