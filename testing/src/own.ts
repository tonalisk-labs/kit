import { fileURLToPath } from 'node:url';

/** A module of this package, from the URL its source resolves to: built, each module is the .js
 *  compiled from that source, and this one shows which the package runs as. */
export const own = (url: string): string =>
  fileURLToPath(import.meta.url.endsWith('.ts') ? url : url.replace(/\.ts$/u, '.js'));
