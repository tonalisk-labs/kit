import { globSync } from 'node:fs';

/** A built page and the answer it must give. */
export interface Route {
  readonly path: string;
  readonly status: 'ok' | 'not-found';
}

/** A path no build writes, which must be answered by the target's own 404 page. */
const MISSING = '/sites-testing-missing-page';

/** Every HTML page in the build in `dir`, as a visitor's path: `index.html` files are directories,
 *  other files drop `.html`, and `404.html` is reached through a missing path. */
export const routesOf = (dir: string): Route[] =>
  globSync('**/*.html', { cwd: dir })
    .toSorted()
    .map((file) => {
      if (file === '404.html') {
        return { path: MISSING, status: 'not-found' };
      }
      const page = file.replace(/(?:^|\/)index\.html$/u, '/').replace(/\.html$/u, '');
      return { path: page.startsWith('/') ? page : `/${page}`, status: 'ok' };
    });
