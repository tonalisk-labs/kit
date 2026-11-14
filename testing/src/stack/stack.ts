import { type Adapter, type Backend, edgeHeadersFor, loadAdapter } from '../adapter.ts';
import type { CspException } from '../csp-exceptions.ts';
import type { Target } from '../discover.ts';
import { buildBackend, startBackend } from './backend.ts';
import { inStackTurn } from './control.ts';
import { type Edge, startEdge, type Upstreams } from './edge.ts';
import { buildSite, startPreview } from './frontend.ts';
import { type FakeGoogle, startFakeGoogle } from './google.ts';
import { type MailSink, startMailpit } from './mailpit.ts';
import { claimPort } from './ports.ts';
import { type Database, startPostgres } from './postgres.ts';
import type { Service } from './process.ts';
import { sandboxRequested, type StripeSandbox, startStripeSandbox } from './stripe-sandbox.ts';
import { type FakeStripe, startFakeStripe } from './stripe.ts';
import { LOCAL_CA_DIR, type Trust, trustCa } from './tls.ts';

/** Where a target's tests find its running stack. */
export interface Coordinates {
  readonly baseURL: string;
  readonly trust: Trust;
  /** The backend over plain HTTP on loopback, without the edge's API prefix, for a client that
   *  can't trust the edge's throwaway CA, as Swift's URLSession on Linux. None with no backend. */
  readonly backendURL: string | undefined;
  /** The site's build output, this stack's own. */
  readonly siteDir: string;
  readonly apiPrefix: string | undefined;
  readonly databaseUrl: string | undefined;
  /** The Postgres container, which statements are run inside with its own psql. */
  readonly databaseContainer: string | undefined;
  readonly mailpit: string | undefined;
  /** The fake Stripe, in a default run. */
  readonly stripe: string | undefined;
  /** In a STRIPE_SANDBOX=1 run, where the events the sandbox sent are watched for. */
  readonly stripeSandbox: string | undefined;
  /** The fake Google Calendar, for its controls. */
  readonly google: string | undefined;
  /** The adapter's browser notices, which the invariants do not count. */
  readonly notices: readonly string[];
  /** The adapter's CSP exceptions, which the invariants let pass on their engines alone. */
  readonly cspExceptions?: readonly CspException[];
}

interface Running extends Service {
  readonly coordinates: Coordinates;
  /** Stops the backend gracefully (SIGTERM, awaited) and starts it again, when there is one. */
  readonly restartBackend: (() => Promise<void>) | undefined;
}

interface Launch {
  readonly target: Target;
  readonly adapter: Adapter | undefined;
  readonly services: Service[];
  readonly signal: AbortSignal;
  /** The backend's restart, once it has started. */
  readonly restarts: (() => Promise<void>)[];
  /** The origin the backend takes as its own, when browsers reach the edge by another name. */
  readonly publicOrigin: string | undefined;
  /** The local CA that signs every edge, so a browser holding it trusts and caches as in
   *  production; its name constraints hold it to loopback. */
  readonly localCa: string;
}

/** The host of the public origin, which the edge's certificate names beside loopback's. */
const publicHost = ({ publicOrigin }: Launch): string | undefined =>
  publicOrigin === undefined ? undefined : new URL(publicOrigin).hostname;

/** The backend as one service across restarts: stopping stops whichever process runs now. */
const restartable = async (
  start: () => Promise<Service>,
): Promise<Service & { readonly restart: () => Promise<void> }> => {
  const running = { current: await start() };
  return {
    stop: async () => running.current.stop(),
    restart: async () => {
      await running.current.stop();
      running.current = await start();
    },
  };
};

const failuresOf = async (work: Promise<void>): Promise<unknown[]> =>
  work.then(
    () => [],
    (error: unknown) => [error],
  );

/** Services stop in the reverse of the order they started, each awaited. One that fails to
 *  stop does not keep the rest running: every service is stopped, then every failure reported. */
const stopInReverse = async (services: Service[], failures: unknown[] = []): Promise<void> => {
  const last = services.pop();
  if (last === undefined) {
    if (failures.length > 0) {
      throw new AggregateError(failures, `${String(failures.length)} services failed to stop`);
    }
    return;
  }
  const failed = await failuresOf(last.stop());
  await stopInReverse(services, [...failures, ...failed]);
};

const keeper =
  (launch: Launch) =>
  <Started extends Service>(service: Started): Started => {
    launch.services.push(service);
    return service;
  };

const fulfilled = <Value>(outcome: PromiseSettledResult<Value>): Value => {
  if (outcome.status === 'rejected') {
    throw outcome.reason;
  }
  return outcome.value;
};

interface Prepared {
  readonly siteDir: string;
  readonly executable: string | undefined;
  readonly database: Database | undefined;
  readonly mail: MailSink | undefined;
  readonly google: FakeGoogle | undefined;
}

/** The slow, independent part, all at once: builds and containers. */
const prepare = async (launch: Launch, backend: Backend | undefined): Promise<Prepared> => {
  const { target, adapter, signal } = launch;
  const keep = keeper(launch);
  const { google: fakesGoogle = false } = backend ?? {};
  const [site, executable, database, mail, google] = await Promise.allSettled([
    buildSite(target.root, adapter === undefined ? {} : adapter.env, signal).then(keep),
    backend === undefined ? undefined : buildBackend(backend.crate, signal, backend.features),
    backend === undefined || backend.roles.length === 0
      ? undefined
      : startPostgres(backend.roles, signal).then(keep),
    backend === undefined || !backend.mail ? undefined : startMailpit(signal).then(keep),
    fakesGoogle ? startFakeGoogle().then(keep) : undefined,
  ]);
  return {
    siteDir: fulfilled(site).dir,
    executable: fulfilled(executable),
    database: fulfilled(database),
    mail: fulfilled(mail),
    google: fulfilled(google),
  };
};

interface Billing {
  readonly service: FakeStripe | StripeSandbox;
  /** The fake's URL, for its controls; none in a sandbox run. */
  readonly fake: string | undefined;
  /** The sandbox's event watch; none in a default run. */
  readonly watch: string | undefined;
}

/** The fake Stripe, or the real sandbox when the run asks for it, never both. */
const startStripe = async (
  launch: Launch,
  { plans, webhookPath }: NonNullable<Backend['stripe']>,
  edge: Edge,
): Promise<Billing> => {
  const webhookUrl = `${edge.origin}${webhookPath}`;
  if (sandboxRequested()) {
    const sandbox = await startStripeSandbox({ plans, webhookUrl, signal: launch.signal });
    return { service: sandbox, fake: undefined, watch: sandbox.watch };
  }
  // The fake posts its webhooks to the edge from this process.
  trustCa(edge.trust.ca);
  const fake = await startFakeStripe({ plans, webhookUrl });
  return { service: fake, fake: fake.url, watch: undefined };
};

/** What the edge sends where; under a public origin the site is asked by its own name. */
const upstreamsOf = (launch: Launch, site: number, api: Upstreams['api']): Upstreams => {
  const { adapter } = launch;
  const edge = adapter === undefined ? undefined : adapter.edgeHeaders;
  const upstreams: Upstreams = {
    site,
    api,
    cacheControl: adapter === undefined ? undefined : adapter.cacheControl,
    siteHost: launch.publicOrigin === undefined ? undefined : `localhost:${String(site)}`,
  };
  return edge === undefined
    ? upstreams
    : Object.assign(upstreams, { headers: (path: string) => edgeHeadersFor(edge, path) });
};

/** What the backend is wired to: what was prepared, the edge before it, its port, and Stripe. */
interface Wiring {
  readonly prepared: Prepared;
  readonly edge: Edge;
  readonly port: number;
  readonly billed: Billing | undefined;
  readonly stripe: Billing['service'] | undefined;
}

/** The backend's environment: its adapter's, under what the backend asks of each service. */
const environmentOf = (
  launch: Launch,
  backend: Backend,
  { prepared, edge, port, stripe }: Wiring,
): Readonly<Record<string, string>> => {
  const { database, mail, google } = prepared;
  const env = backend.env({
    origin: launch.publicOrigin ?? edge.origin,
    bindAddr: `127.0.0.1:${String(port)}`,
    database: database ?? { ownerUrl: '', urls: new Map() },
    mail:
      mail === undefined
        ? undefined
        : { host: mail.smtpHost, port: mail.smtpPort, caFile: mail.caFile },
    stripe,
    google: google === undefined ? undefined : { url: google.url },
  });
  const adapterEnv = launch.adapter === undefined ? {} : launch.adapter.env;
  return Object.fromEntries([...Object.entries(adapterEnv), ...Object.entries(env)]);
};

/** Where a run finds each service of the app, once all have started. */
const coordinatesOf = (
  launch: Launch,
  backend: Backend,
  { prepared, edge, port, billed }: Wiring,
): Coordinates => {
  const { siteDir, database, mail, google } = prepared;
  return {
    baseURL: edge.origin,
    trust: edge.trust,
    backendURL: `http://127.0.0.1:${String(port)}`,
    siteDir,
    apiPrefix: backend.apiPrefix,
    databaseUrl: database === undefined ? undefined : database.ownerUrl,
    databaseContainer: database === undefined ? undefined : database.container,
    mailpit: mail === undefined ? undefined : mail.api,
    stripe: billed === undefined ? undefined : billed.fake,
    stripeSandbox: billed === undefined ? undefined : billed.watch,
    google: google === undefined ? undefined : google.url,
    notices: noticesOf(launch),
    cspExceptions: cspExceptionsOf(launch),
  };
};

/** The edge, Stripe and the backend, in the order each needs the one before. */
const serveApp = async (
  launch: Launch,
  prepared: Prepared & { readonly sitePort: number },
  backend: Backend,
): Promise<Coordinates> => {
  const { executable, database, sitePort } = prepared;
  const keep = keeper(launch);
  if (executable === undefined || (database === undefined && backend.roles.length > 0)) {
    throw new Error(`${launch.target.name}: its backend was not prepared`);
  }
  const { port } = keep(await claimPort());
  const api = { prefix: backend.apiPrefix, port };
  const edge = keep(
    await startEdge(upstreamsOf(launch, sitePort, api), launch.signal, {
      localCa: launch.localCa,
      host: publicHost(launch),
    }),
  );
  const { stripe: billing } = backend;
  const billed = billing === undefined ? undefined : await startStripe(launch, billing, edge);
  const stripe = billed === undefined ? undefined : keep(billed.service);
  const wiring: Wiring = { prepared, edge, port, billed, stripe };
  const environment = environmentOf(launch, backend, wiring);
  const backendService = keep(
    await restartable(async () => startBackend(executable, environment, launch.signal)),
  );
  // The edge counts what the backend refuses while it restarts, rather than saying it as a fault.
  launch.restarts.push(async () => {
    await edge.whileDown(port, backendService.restart);
  });
  return coordinatesOf(launch, backend, wiring);
};

const noticesOf = ({ adapter }: Launch): readonly string[] =>
  (adapter === undefined ? undefined : adapter.notices) ?? [];

const cspExceptionsOf = ({ adapter }: Launch): readonly CspException[] =>
  (adapter === undefined ? undefined : adapter.cspExceptions) ?? [];

const serveSite = async (
  launch: Launch,
  { siteDir, sitePort }: { readonly siteDir: string; readonly sitePort: number },
): Promise<Coordinates> => {
  const edge = keeper(launch)(
    await startEdge(
      { site: sitePort, api: undefined, cacheControl: undefined, siteHost: undefined },
      launch.signal,
      { localCa: launch.localCa, host: publicHost(launch) },
    ),
  );
  return {
    baseURL: edge.origin,
    trust: edge.trust,
    backendURL: undefined,
    siteDir,
    apiPrefix: undefined,
    databaseUrl: undefined,
    databaseContainer: undefined,
    mailpit: undefined,
    stripe: undefined,
    stripeSandbox: undefined,
    google: undefined,
    notices: noticesOf(launch),
    cspExceptions: cspExceptionsOf(launch),
  };
};

export interface StartOptions {
  readonly signal: AbortSignal;
  readonly turns: string;
  readonly publicOrigin?: string | undefined;
}

/** Builds and serves one target behind its edge with only the services its adapter names, its
 *  build in a CPU turn; under a public origin the backend answers as that origin. */
export const startTarget = async (
  target: Target,
  { signal, turns, publicOrigin }: StartOptions,
): Promise<Running> => {
  const services: Service[] = [];
  const stop = async (): Promise<void> => stopInReverse(services);
  try {
    const adapter = await loadAdapter(target.adapter);
    const launch: Launch = {
      target,
      adapter,
      services,
      signal,
      restarts: [],
      publicOrigin,
      localCa: LOCAL_CA_DIR,
    };
    const backend = adapter === undefined ? undefined : adapter.backend;
    const prepared = await inStackTurn(turns, async () => prepare(launch, backend));
    signal.throwIfAborted();
    const { port: sitePort } = keeper(launch)(
      await startPreview(target.root, prepared.siteDir, signal),
    );
    signal.throwIfAborted();
    const coordinates =
      backend === undefined
        ? await serveSite(launch, { siteDir: prepared.siteDir, sitePort })
        : await serveApp(launch, Object.assign(prepared, { sitePort }), backend);
    const [restartBackend] = launch.restarts;
    return { coordinates, stop, restartBackend };
  } catch (error) {
    const failed = await failuresOf(stop());
    throw failed.length === 0
      ? error
      : new AggregateError([error, ...failed], 'start and stop failed');
  }
};
