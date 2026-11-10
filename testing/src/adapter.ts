import type { Page } from '@playwright/test';

import type { CspException } from './csp-exceptions.ts';
import type { Role } from './stack/postgres.ts';
import type { Plan } from './stack/stripe.ts';
import { isObject } from './unknown.ts';

/** What the stack started for a target, for its adapter to configure the backend with. */
export interface Started {
  /** The public origin, the edge proxy's. */
  readonly origin: string;
  /** Where the backend must listen. */
  readonly bindAddr: string;
  /** Empty (no URL, no roles) when the backend declares no roles: no Postgres is started. */
  readonly database: { readonly ownerUrl: string; readonly urls: ReadonlyMap<string, string> };
  /** SMTP requiring STARTTLS, with the CA its certificate chains to. */
  readonly mail:
    | { readonly host: string; readonly port: number; readonly caFile: string }
    | undefined;
  readonly stripe:
    | {
        readonly url: string;
        readonly secretKey: string;
        /** The key a page initialises Stripe.js with. */
        readonly publishableKey: string;
        readonly webhookSecret: string;
        /** The price Stripe knows each plan by, keyed by the plan's id. */
        readonly prices: ReadonlyMap<string, string>;
      }
    | undefined;
  /** The fake Google Calendar, whose base serves the API and the OAuth token endpoint alike. */
  readonly google: { readonly url: string } | undefined;
}

/** A backend, and the services it needs; each is started only because an adapter names it. */
export interface Backend {
  /** The Cargo package, built in release with these features. */
  readonly crate: string;
  readonly features?: readonly string[];
  /** The path prefix the edge sends to the backend, stripped as production does. */
  readonly apiPrefix: string;
  /** Postgres login roles, created before the backend migrates; none starts no Postgres. */
  readonly roles: readonly Role[];
  readonly mail: boolean;
  readonly stripe: { readonly plans: readonly Plan[]; readonly webhookPath: string } | undefined;
  /** Whether it calls Google Calendar, which the stack then fakes. */
  readonly google?: boolean;
  /** The backend's whole environment, from what the stack started. */
  readonly env: (started: Started) => Readonly<Record<string, string>>;
}

/** What a site's SEO expects that its build cannot tell, for the static check (seo-static.ts). */
export interface SeoProfile {
  /** The pages kept out of the index, as their addresses; `*` stands for one path segment. The
   *  404 page always is. */
  readonly noindex: readonly string[];
  /** The paths robots.txt keeps every crawler out of. */
  readonly disallow: readonly string[];
}

/** The headers a production edge adds to its answers, by class: each answer takes the classes
 *  `classesOf` names for its path, in order, a later class's header in place of an earlier's. */
export interface EdgeHeaders {
  readonly classes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly classesOf: (path: string) => readonly string[];
}

/** The headers an answer to `path` takes, with their names in lower case as HTTP/2 sends them. */
export const edgeHeadersFor = (edge: EdgeHeaders, path: string): Record<string, string> =>
  Object.fromEntries(
    edge.classesOf(path).flatMap((name) => {
      const found = edge.classes[name];
      if (found === undefined) {
        throw new Error(`the edge's headers have no class ${name}`);
      }
      return Object.entries(found).map(([header, value]) => [header.toLowerCase(), value]);
    }),
  );

/** What a target adds to the shared harness, from its `tests/app.ts`. */
export interface Adapter {
  /** Environment for the frontend build, and for the backend too. */
  readonly env: Readonly<Record<string, string>>;
  readonly backend: Backend | undefined;
  /** Target-specific properties of every public page, as failure messages. */
  readonly pageChecks: ((page: Page) => Promise<string[]>) | undefined;
  /** The `Cache-Control` its production edge sets on the site's answers, by path and status,
   *  for the test edge to send; none passes the preview's own. */
  readonly cacheControl?: (path: string, status: number) => string;
  /** The headers its production edge adds to every answer, the API's included, for the test edge
   *  to send alike and the guard to hold each answer to; none adds none. */
  readonly edgeHeaders?: EdgeHeaders;
  /** What its SEO expects that the build cannot tell; none keeps only the 404 page out of the
   *  index and disallows nothing. */
  readonly seo?: SeoProfile;
  /** What its browsers write that is no fault of the target: a console message that includes
   *  one is not counted, as the target's own monitoring drops it. */
  readonly notices?: readonly string[];
  /** CSP violations an engine reports through a defect of its own, each let pass on that engine
   *  alone until its day to be looked at again. */
  readonly cspExceptions?: readonly CspException[];
}

/** Types a target's adapter: `tests/app.ts` exports `adapter = defineAdapter({ … })`. */
export const defineAdapter = (adapter: Adapter): Adapter => adapter;

const isAdapter = (value: unknown): value is Adapter =>
  isObject(value) && 'env' in value && 'backend' in value;

/** A target's adapter, or none for a target that brings only pages. */
export const loadAdapter = async (file: string | undefined): Promise<Adapter | undefined> => {
  if (file === undefined) {
    return undefined;
  }
  const module: unknown = await import(file);
  const adapter = isObject(module) ? module['adapter'] : undefined;
  if (!isAdapter(adapter)) {
    throw new TypeError(`${file} exports no \`adapter\` made with defineAdapter`);
  }
  return adapter;
};
