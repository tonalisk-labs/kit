import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { own } from '../own.ts';
import { isObject } from '../unknown.ts';
import { leftovers } from './leftovers.ts';
import { run, serve, type Service } from './process.ts';

export interface Preview extends Service {
  readonly port: number;
}

interface Build extends Service {
  /** The stack's own build output; removed when the stack stops. */
  readonly dir: string;
}

/** The Astro package the target itself depends on. */
export const astroOf = (root: string): { readonly bin: string; readonly main: string } => {
  const require = createRequire(path.join(root, 'package.json'));
  const manifest = require.resolve('astro/package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const bin = isObject(parsed) && isObject(parsed['bin']) ? parsed['bin']['astro'] : undefined;
  if (typeof bin !== 'string') {
    throw new TypeError(`${manifest} names no astro binary`);
  }
  return { bin: path.join(path.dirname(manifest), bin), main: require.resolve('astro') };
};

/** A directory of this stack's own for the build, in the target's git-ignored `.astro`: macOS
 *  sweeps its temp of files untouched 3 days, and Astro's copies of `public/` keep their times. */
export const siteDirIn = async (root: string): Promise<string> => {
  await mkdir(path.join(root, '.astro'), { recursive: true });
  return mkdtemp(path.join(root, '.astro', 'site-'));
};

/** Builds the target with its own Astro into dirs of this run's own, so runs never mix output. The
 *  work dir, where Astro stages prerendered pages, sits in the project for its packages. */
export const buildSite = async (
  root: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Build> => {
  const dir = await siteDirIn(root);
  const forget = leftovers.dir(dir);
  const stop = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
    forget();
  };
  const work = await mkdtemp(path.join(root, '.astro', 'build-'));
  const forgetWork = leftovers.dir(work);
  const environment = Object.fromEntries([
    ...Object.entries(process.env),
    ...Object.entries(env),
    ['TMPDIR', work],
    ['NODE_DISABLE_COMPILE_CACHE', '1'],
  ]);
  try {
    await run(process.execPath, [astroOf(root).bin, 'build', '--root', root, '--outDir', dir], {
      cwd: work,
      env: environment,
      signal,
    });
  } catch (error) {
    await stop();
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
    forgetWork();
  }
  return { dir, stop };
};

/** What the preview's process says once it listens, its port after it. */
export const PREVIEW_READY = 'the preview listens on port ';

/** The port a ready line names: a whole number from 1 to 65535, written plainly, or a failure that
 *  quotes the line. */
export const previewPortOf = (line: string): number => {
  const written = line.slice(PREVIEW_READY.length);
  const port = Number(written);
  if (!/^[1-9]\d*$/u.test(written) || port > 65_535) {
    throw new Error(`the preview named no port it could listen on: ${line}`);
  }
  return port;
};

/** Serves the build in `outDir` from a process of its own, as the backend is: in the stack's process,
 *  busy with every browser's traffic, a server accepts the edge's connections only as that loop turns. */
export const startPreview = async (
  root: string,
  outDir: string,
  signal: AbortSignal,
): Promise<Preview> => {
  const child = own(import.meta.resolve('./preview-child.ts'));
  const bound = { line: '' };
  const server = await serve(process.execPath, [child, root, outDir], {
    cwd: root,
    ready: [PREVIEW_READY],
    onLine: (line) => {
      if (line.startsWith(PREVIEW_READY)) {
        bound.line = line;
      }
    },
    lifeline: true,
    signal,
  });
  try {
    return { port: previewPortOf(bound.line), stop: server.stop };
  } catch (error) {
    await server.stop();
    throw error;
  }
};
