// A sitemap entry's lastmod is when its page's sources last changed, never the build's time: one
// stamp on every page teaches search engines to ignore the dates.
import { execFileSync } from 'node:child_process';

interface Entry {
  url: string;
  lastmod?: string | undefined;
}

/** The last commit's author date for `files`, as a W3C datetime: when the change was written,
 *  which a rebase or a cherry-pick keeps. The build needs the full history, not a shallow clone. */
export const lastChanged = (cwd: string, files: readonly string[]): string | undefined => {
  if (files.length === 0) {
    return undefined;
  }
  const date = execFileSync('git', ['log', '-1', '--format=%aI', '--', ...files], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return date === '' ? undefined : date;
};

/** A sitemap `serialize`: `sourcesOf` names the files, from `root`, that make a page. */
export const datedBy =
  (root: string, sourcesOf: (pathname: string) => readonly string[]) =>
  <Item extends Entry>(item: Item): Item => {
    const lastmod = lastChanged(root, sourcesOf(new URL(item.url).pathname));
    return lastmod === undefined ? item : Object.assign(item, { lastmod });
  };
