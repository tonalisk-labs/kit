import type { Page, Request } from '@playwright/test';

import { byStripe } from './sandbox-stripe.ts';

/** This machine's own hosts, where the stack's services and stand-ins listen. */
const LOOPBACK = /^(?:localhost|[\w-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/** The web URL `address` names, when it is neither first-party nor on this machine. */
const thirdParty = (address: string, origin: string): URL | undefined => {
  if (!URL.canParse(address)) {
    return undefined;
  }
  const url = new URL(address);
  const web = url.protocol === 'https:' || url.protocol === 'http:';
  return web && url.origin !== origin && !LOOPBACK.test(url.hostname) ? url : undefined;
};

/** Whether a request with no answer went out on the network: one a route aborted never did. */
const sentOut = (request: Request): boolean => {
  const { domainLookupStart, connectStart, requestStart } = request.timing();
  return [domainLookupStart, connectStart, requestStart].some((at) => at >= 0);
};

/** Whether a request reached its server: a route's stand-in answer comes from no address. */
const reachedOut = async (request: Request): Promise<boolean> => {
  const response = await request.response();
  return response === null ? sentOut(request) : (await response.serverAddr()) !== null;
};

/** The requests a page made that the watch judges: a wait for those still being judged, and the
 *  address of each Stripe made. */
export interface ThirdParties {
  readonly judged: () => Promise<void>;
  readonly asked: ReadonlySet<string>;
}

/** Files every request that reached a third party's origin, unless a `page.route` stand-in or the
 *  opt-in Stripe sandbox covers it. */
export const hearThirdParties = (page: Page, origin: string, problems: string[]): ThirdParties => {
  const judging: Promise<void>[] = [];
  const stripes = new WeakSet<Request>();
  const asked = new Set<string>();
  page.on('request', (request) => {
    if (byStripe(page, request)) {
      stripes.add(request);
      asked.add(request.url());
    }
  });
  const judge = async (request: Request): Promise<void> => {
    const address = request.url();
    const allowed = stripes.has(request);
    if (thirdParty(address, origin) !== undefined && !allowed && (await reachedOut(request))) {
      problems.push(`${request.method()} ${address} reached a third-party origin`);
    }
  };
  const look = (request: Request): void => {
    judging.push(
      judge(request).catch((error: unknown) => {
        problems.push(
          `${request.url()} could not be judged first- or third-party: ${String(error)}`,
        );
      }),
    );
  };
  page.on('requestfinished', look);
  page.on('requestfailed', look);
  return {
    judged: async () => {
      await Promise.all(judging.splice(0));
    },
    asked,
  };
};
