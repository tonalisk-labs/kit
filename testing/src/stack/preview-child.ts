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
  }) => Promise<{ readonly port: number; readonly stop: () => Promise<void> }>;
}

const isAstro = (value: unknown): value is Astro =>
  isObject(value) && typeof value['preview'] === 'function';

interface Lifeline {
  ended: boolean;
  server: { readonly stop: () => Promise<void> } | undefined;
  readonly stopping: Promise<void>[];
}

const lifeline: Lifeline = { ended: false, server: undefined, stopping: [] };

// Its lifeline gone, it stops its server and ends with nothing left to run, exiting 0. Vite would
// too, but only where CI isn't "true"; this comes first, and the stop takes Vite's listener away.
process.stdin.on('end', () => {
  lifeline.ended = true;
  if (lifeline.server !== undefined) {
    lifeline.stopping.push(lifeline.server.stop());
  }
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
lifeline.server = server;
if (lifeline.ended) {
  await server.stop();
} else {
  console.log(`${PREVIEW_READY}${String(server.port)}`);
}
