import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { isObject } from '../unknown.ts';
import { container, exec, networkOf } from './containers.ts';
import type { Service } from './process.ts';
import type { ContainerSpec } from './runtime.ts';
import { type Socks, startSocks } from './socks.ts';
import { LOCAL_CA_DIR, localCaCertificate } from './tls.ts';

/** The engines the image serves, one browser each: the visual projects' Chromium, and WebKit for
 *  the rows macOS can't run it on. */
const ENGINES = ['chromium', 'webkit'] as const;

type Engine = (typeof ENGINES)[number];

/** Each engine's browser on a port of its own, at a path named for it. */
const PORTS: Readonly<Record<Engine, number>> = { chromium: 3000, webkit: 3001 };

/** Where each engine's browser is served, by engine. */
type Endpoints = Readonly<Record<Engine, string>>;

export interface BrowserServer extends Service {
  readonly endpoints: Endpoints;
}

/** The endpoint of the image's browser for `engine` in `given`, the stack host's variable; none
 *  where the variable is unset or names no such engine. */
export const endpointOf = (engine: string, given?: string): string | undefined => {
  const parsed: unknown = given === undefined ? undefined : JSON.parse(given);
  const endpoint = isObject(parsed) ? parsed[engine] : undefined;
  return typeof endpoint === 'string' ? endpoint : undefined;
};

/** Browser contexts the image serves at once, a seat each, taken by a test for its own time: each
 *  engine's one browser is shared by every worker, so a connection costs nothing. */
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

/** A browser costs about 225 MiB and a context about 460, so the two browsers and a full pool's
 *  contexts come to about 2,290 MiB of these 3,328: a VM keeps what it touched. */
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

/** Where the host writes the proxy's address once it listens, and the container's IPv6 address:
 *  only then may the browsers launch, as each takes its proxy as it launches. */
const PROXY_PIPE = '/tmp/proxy';

/** Each engine's browser behind the host's proxy, for every worker: one that crashes fails its
 *  tests and is launched again at its address; on stop, the process exits once all have closed. */
const SERVE = `
const playwright = require('/playwright-core');
const engines = ${JSON.stringify(Object.entries(PORTS))};
const proxy = { server: process.env.PROXY };
const state = { stopping: false, open: engines.length };
// Chromium fails its open navigations when the container's IPv6 address arrives after it launched
// (ERR_NETWORK_CHANGED), so the browsers launch once it's there, or after 30 s without it.
const settled = async (left = 300) => {
  const wanted = process.env.SETTLED;
  const addresses = Object.values(require('node:os').networkInterfaces()).flat();
  if (!wanted || left === 0 || addresses.some((one) => one.address === wanted)) return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settled(left - 1);
};
process.once('SIGTERM', () => { state.stopping = true; });
const failed = (error) => { console.error(error); process.exit(1); };
const serve = async ([engine, port]) => {
  const server = await playwright[engine].launchServer({ port, host: '0.0.0.0', wsPath: '/' + engine, proxy });
  server.once('close', () => {
    if (state.stopping) {
      state.open -= 1;
      if (state.open === 0) process.exit(0);
      return;
    }
    console.log(engine + ' closed, launched again');
    serve([engine, port]).catch(failed);
  });
  console.log(engine + ' serves ' + server.wsEndpoint());
};
(async () => {
  await settled();
  for (const entry of engines) await serve(entry);
})().catch(failed);
`;

/** Takes the local CA's certificate into the image's store, waits for the proxy's address, then
 *  serves. A pipe the host wrote first is a plain file, which reads as well. */
const TRUSTED_SERVER = [
  String.raw`printf "%s\n" "$EDGE_CA" > ${CA_FILE}`,
  'update-ca-certificates > /dev/null',
  `{ mkfifo ${PROXY_PIPE} 2> /dev/null || true; }`,
  `{ read -r PROXY && read -r SETTLED; } < ${PROXY_PIPE}`,
  'export PROXY SETTLED',
  `exec node -e "$1" > ${LOG_FILE} 2>&1`,
].join(' && ');

/** The image serving `core`'s browsers, trusting the CA in `ca`: a certificate passed in its
 *  environment, so no key is ever mounted. */
export const browserServerSpec = (
  core: { readonly root: string; readonly version: string },
  ca: string,
): ContainerSpec => ({
  image: `mcr.microsoft.com/playwright:v${core.version}-noble`,
  ports: Object.values(PORTS),
  ready: ENGINES.map((engine) => `${engine} serves`),
  logFile: LOG_FILE,
  env: { EDGE_CA: ca, NODE_EXTRA_CA_CERTS: CA_FILE },
  init: true,
  sharesMemory: true,
  machine: MACHINE,
  files: [core.root, '/playwright-core'],
  command: ['sh', '-c', TRUSTED_SERVER, 'sh', SERVE],
});

/** Starts the host's proxy for the container `id`, on the host's address on its network and for
 *  its address alone, and gives the browsers its address. */
const proxyFor = async (id: string, signal: AbortSignal): Promise<Socks> => {
  const { own, host, settled = '' } = await networkOf(id);
  const socks = await startSocks({ host, peer: own });
  try {
    const address = `socks5://${host}:${String(socks.port)}`;
    const told = [
      'sh',
      '-c',
      `printf "%s\\n%s\\n" "$1" "$2" > ${PROXY_PIPE}`,
      'sh',
      address,
      settled,
    ];
    await exec(id, told, signal);
    return socks;
  } catch (error) {
    await socks.stop();
    throw error;
  }
};

/** Playwright's browsers in its official Linux image, served to the host's tests so screenshots
 *  render the same on every machine, trusting the local CA in `caDir` that signs every edge. */
export const startBrowserServer = async (
  signal: AbortSignal,
  caDir = LOCAL_CA_DIR,
): Promise<BrowserServer> => {
  const ca = await localCaCertificate(caDir, signal);
  const proxied: { socks?: Socks } = {};
  const started = async (id: string): Promise<void> => {
    proxied.socks = await proxyFor(id, signal);
  };
  const stopProxy = async (): Promise<void> => {
    if (proxied.socks !== undefined) {
      await proxied.socks.stop();
    }
  };
  const server = await container(browserServerSpec(playwrightCore(), ca), signal, started).catch(
    async (error: unknown) => {
      await stopProxy();
      throw error;
    },
  );
  const endpointFor = (engine: Engine): string => {
    const { host, port } = server.address(PORTS[engine]);
    return `ws://${host}:${String(port)}/${engine}`;
  };
  return {
    endpoints: { chromium: endpointFor('chromium'), webkit: endpointFor('webkit') },
    stop: async () => {
      await server.stop();
      await stopProxy();
    },
  };
};
