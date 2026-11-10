// Source text for the style lint: lines by offset, blanked spans that keep them, and an Astro
// file's frontmatter apart from its template.

/** The 1-based line of an offset in `source`: the line starts are found once, then searched. */
export const linesOf = (source: string): ((offset: number) => number) => {
  const starts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  return (offset) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
};

/** Text with every character but line breaks made a space, so offsets and lines still hold. */
export const blank = (text: string): string => text.replaceAll(/[^\n]/gu, ' ');

export const groupsOf = (match: RegExpMatchArray | null): Partial<Record<string, string>> =>
  (match ?? { groups: {} }).groups ?? {};

const FENCE = '---\n';

/** An Astro file's frontmatter, and where its template starts. */
export const astroParts = (source: string): { frontmatter: string; template: number } => {
  const end = source.startsWith(FENCE) ? source.indexOf(`\n${FENCE}`, FENCE.length - 1) : -1;
  return end === -1
    ? { frontmatter: '', template: 0 }
    : { frontmatter: source.slice(FENCE.length, end), template: end + 1 + FENCE.length };
};
