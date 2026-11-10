// A page's SEO basics, read in the browser by the e2e sweep or from the built HTML by the static
// check, and judged alike.
export interface SeoFacts {
  readonly lang: string;
  readonly canonicals: readonly string[];
  /** Every `robots` and `googlebot` meta's content, joined by commas. */
  readonly robots: string;
  readonly descriptions: readonly string[];
  readonly headings: readonly string[];
  /** Each JSON-LD block's text. */
  readonly data: readonly string[];
}

type BasicRule = 'P01' | 'P05' | 'P08' | 'P10' | 'P17';

/** Runs in the page, so it uses nothing else of this module. */
export const seoFacts = (): SeoFacts => {
  const { document } = globalThis;
  const all = (selector: string): Element[] => [...document.querySelectorAll(selector)];
  const contents = (selector: string): string[] =>
    all(selector).map((meta) => meta.getAttribute('content') ?? '');
  return {
    lang: document.documentElement.lang,
    canonicals: all('link[rel="canonical"]').map((link) => link.getAttribute('href') ?? ''),
    robots: contents('meta[name="robots"], meta[name="googlebot"]').join(','),
    descriptions: contents('meta[name="description"]'),
    headings: all('h1').map((heading) => heading.textContent),
    data: all('script[type="application/ld+json"]').map((script) => script.textContent),
  };
};

/** A robots meta's directives, lower-cased: `noindex, nofollow` is `noindex` and `nofollow`. */
export const directivesOf = (robots: string): string[] =>
  robots
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .filter((directive) => directive !== '');

export const keptOut = (robots: string): boolean =>
  directivesOf(robots).some((directive) => directive === 'noindex' || directive === 'none');

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export const seoBasics = (facts: SeoFacts): (readonly [BasicRule, string])[] => {
  const { canonicals, data } = facts;
  const unparsed = data.filter((text) => !parses(text)).length;
  const checks: readonly (readonly [BasicRule, boolean, string])[] = [
    ['P01', facts.lang.trim() !== '', '<html> has no lang'],
    // A page kept out of the index names no canonical; every other page names one.
    keptOut(facts.robots)
      ? [
          'P10',
          canonicals.length === 0,
          `${String(canonicals.length)} canonical links on a noindex page`,
        ]
      : [
          'P10',
          canonicals.length === 1 && canonicals[0] !== '',
          `${String(canonicals.length)} canonical links, not one with an href`,
        ],
    ['P05', (facts.descriptions[0] ?? '').trim() !== '', 'no meta description'],
    ['P08', facts.headings.length === 1, `${String(facts.headings.length)} h1 elements, not one`],
    ['P17', data.length > 0, 'no JSON-LD'],
    ['P17', unparsed === 0, `${String(unparsed)} JSON-LD blocks do not parse`],
  ];
  return checks.filter(([, passed]) => !passed).map(([rule, , message]) => [rule, message]);
};

export const seoProblems = (facts: SeoFacts): string[] =>
  seoBasics(facts).map(([, message]) => message);
