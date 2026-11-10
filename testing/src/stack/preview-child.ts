// A target's build served by its own Astro's preview, in a process of its own, which `startPreview`
// starts, reads the port from, and stops with SIGTERM; it also ends with its stdin, the stack's
// lifeline, so a killed stack leaves no server behind. Usage: preview-child.ts <root> <outDir>
import { pathToFileURL } from 'node:url';

import { isObject } from '../unknown.ts';
import { astroOf, PREVIEW_READY } from './frontend.ts';

interface Astro {
  readonly preview: (options: {
    readonly root: string;
    readonly outDir: string;
    readonly logLevel: 'error';
    readonly server: { readonly host: string; readonly port: number };
  }) => Promise<{ readonly port: number }>;
}

const isAstro = (value: unknown): value is Astro =>
  isObject(value) && typeof value['preview'] === 'function';

// Its lifeline gone, it stops as a stop would have it.
process.stdin.on('end', () => {
  process.kill(process.pid, 'SIGTERM');
});
process.stdin.resume();
const [root = '', outDir = ''] = process.argv.slice(2);
const astro: unknown = await import(pathToFileURL(astroOf(root).main).href);
if (!isAstro(astro)) {
  throw new TypeError(`the astro package of ${root} has no preview API`);
}
// Vite's preview closes and exits on SIGTERM, as a stop asks.
const server = await astro.preview({
  root,
  outDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
console.log(`${PREVIEW_READY}${String(server.port)}`);
