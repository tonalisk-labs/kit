import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { isObject } from '../unknown.ts';
import { container } from './containers.ts';
import type { Service } from './process.ts';
import type { ContainerSpec } from './runtime.ts';
import { LOCAL_CA_DIR, localCaCertificate } from './tls.ts';

export interface BrowserServer extends Service {
  readonly wsEndpoint: string;
}

const PORT = 3000;

/** Browser contexts the image serves at once, a seat each: 4 in one browser peak at 2,272 MiB, 4
 *  browsers of one each at 2,947, and neither stalls nor is killed. */
export const BROWSER_SEATS = 4;

/** A test's devices against the `declared` contexts it may have open, its own included: each is
 *  counted as it is asked for, so devices asked for together through Promise.all are all counted. */
export const deviceBudget = (declared: number): (() => () => void) => {
  const state = { open: 0 };
  return () => {
    if (state.open + 2 > declared) {
      throw new Error(
        `a test here has at most ${String(declared)} browser contexts open, its own included: declare more with test.use({ browserContexts })`,
      );
    }
    state.open += 1;
    const given = { back: false };
    return () => {
      if (!given.back) {
        given.back = true;
        state.open -= 1;
      }
    };
  };
};

/** A browser costs about 225 MiB and a context about 460; the worst full pool, 4 browsers, peaked
 *  at 2,947 MiB of these 3,328 with no stall: a VM keeps what it touched. */
const MACHINE = { memory: 3328, cpus: availableParallelism() } as const;

/** The playwright-core the tests run, mounted into the image of the same release. */
export const playwrightCore = (): { readonly root: string; readonly version: string } => {
  const fromTest = createRequire(import.meta.resolve('@playwright/test/package.json'));
  const manifest = fromTest.resolve('playwright-core/package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const version = isObject(parsed) ? parsed['version'] : undefined;
  if (typeof version !== 'string') {
    throw new TypeError(`${manifest} has no version`);
  }
  return { root: path.dirname(manifest), version };
};

/** The server's own log, as `container` can stop relaying output at an exec (postgres.ts). */
const LOG_FILE = '/tmp/browsers.log';

/** The local CA in the image's store, which WebKit reads, and Node by NODE_EXTRA_CA_CERTS: the
 *  server's Node makes a context's own requests, as `route.fetch` and `context.request` do. */
const CA_FILE = '/usr/local/share/ca-certificates/tonalisk-kit-edge.crt';

/** Takes the local CA's certificate into the image's store, then serves. */
const TRUSTED_SERVER = [
  String.raw`printf "%s\n" "$EDGE_CA" > ${CA_FILE}`,
  'update-ca-certificates > /dev/null',
  `exec node /playwright-core/cli.js run-server --port ${String(PORT)} --host 0.0.0.0 > ${LOG_FILE} 2>&1`,
].join(' && ');

/** The image serving `core`'s browsers, trusting the CA in `ca`: a certificate passed in its
 *  environment, so no key is ever mounted. */
export const browserServerSpec = (
  core: { readonly root: string; readonly version: string },
  ca: string,
): ContainerSpec => ({
  image: `mcr.microsoft.com/playwright:v${core.version}-noble`,
  ports: [PORT],
  ready: ['Listening on'],
  logFile: LOG_FILE,
  env: { EDGE_CA: ca, NODE_EXTRA_CA_CERTS: CA_FILE },
  init: true,
  sharesMemory: true,
  machine: MACHINE,
  files: [core.root, '/playwright-core'],
  command: ['sh', '-c', TRUSTED_SERVER],
});

/** Playwright's browsers in its official Linux image, served to the host's tests so screenshots
 *  render the same on every machine, trusting the local CA in `caDir` that signs every edge. */
export const startBrowserServer = async (
  signal: AbortSignal,
  caDir = LOCAL_CA_DIR,
): Promise<BrowserServer> => {
  const ca = await localCaCertificate(caDir, signal);
  const server = await container(browserServerSpec(playwrightCore(), ca), signal);
  const { host, port } = server.address(PORT);
  return { wsEndpoint: `ws://${host}:${String(port)}/`, stop: server.stop };
};
