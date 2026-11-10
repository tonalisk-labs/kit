// A sitemap or sitemap index read by a strict XML parser, so ill-formed XML throws.
import sax from 'sax';

export const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export interface SitemapEntry {
  readonly loc: string;
  readonly lastmod: string | undefined;
}

interface Sitemap {
  /** `sitemapindex` or `urlset`. */
  readonly root: string;
  readonly namespace: string;
  /** Each `sitemap` of an index, or each `url` of a set. */
  readonly entries: readonly SitemapEntry[];
}

/** An entry's depth: the root holds entries, each entry holds `loc` and `lastmod`. */
const ENTRY_DEPTH = 2;

interface Reading {
  readonly path: string[];
  readonly entries: SitemapEntry[];
  root: { readonly name: string; readonly namespace: string } | undefined;
  loc: string;
  lastmod: string | undefined;
  failure: Error | undefined;
}

const open = (reading: Reading, tag: sax.Tag | sax.QualifiedTag): void => {
  const qualified = 'local' in tag;
  const name = qualified ? tag.local : tag.name;
  reading.root ??= { name, namespace: qualified ? tag.uri : '' };
  reading.path.push(name);
};

const readText = (reading: Reading, text: string): void => {
  const field = reading.path.at(ENTRY_DEPTH);
  if (field === 'loc') {
    reading.loc += text;
  } else if (field === 'lastmod') {
    reading.lastmod = (reading.lastmod ?? '') + text;
  }
};

const close = (reading: Reading): void => {
  if (reading.path.length === ENTRY_DEPTH) {
    const lastmod = reading.lastmod === undefined ? undefined : reading.lastmod.trim();
    reading.entries.push({ loc: reading.loc.trim(), lastmod });
    reading.loc = '';
    reading.lastmod = undefined;
  }
  reading.path.pop();
};

export const readSitemap = (xml: string): Sitemap => {
  const reading: Reading = {
    path: [],
    entries: [],
    root: undefined,
    loc: '',
    lastmod: undefined,
    failure: undefined,
  };
  const stream = sax.createStream(true, { xmlns: true });
  stream.on('opentag', (tag: sax.Tag | sax.QualifiedTag) => {
    open(reading, tag);
  });
  stream.on('text', (text: string) => {
    readText(reading, text);
  });
  stream.on('closetag', () => {
    close(reading);
  });
  stream.on('error', (failure: Error) => {
    reading.failure ??= failure;
  });
  stream.end(xml);
  if (reading.failure !== undefined) {
    throw reading.failure;
  }
  if (reading.root === undefined) {
    throw new Error('no root element');
  }
  return { root: reading.root.name, namespace: reading.root.namespace, entries: reading.entries };
};
