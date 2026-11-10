// Stripe.js in a page under test: https://js.stripe.com answers with the fake Stripe's stand-in,
// and https://api.stripe.com, which the stand-in asks, with the fake itself. The page's own
// Content-Security-Policy, the one production has, still judges both, and no request leaves.
import type { Page, Route } from '@playwright/test';

export { DECLINED_CARD } from './stack/stripe-js.ts';

/** Sends a request for Stripe's API to the fake, readable cross-origin as Stripe's are. */
const forward = async (route: Route, fake: string): Promise<void> => {
  const asked = new URL(route.request().url());
  const response = await route.fetch({ url: `${fake}${asked.pathname}${asked.search}` });
  const headers = Object.assign(response.headers(), { 'access-control-allow-origin': '*' });
  await route.fulfill({ response, headers });
};

/** Stands the fake Stripe in for Stripe.js and its API on `page`, or on a whole context. */
export const standInForStripe = async (page: Pick<Page, 'route'>, fake: string): Promise<void> => {
  await page.route('https://js.stripe.com/**', async (route) => {
    await route.fulfill({ response: await route.fetch({ url: `${fake}/fake/stripe.js` }) });
  });
  await page.route('https://api.stripe.com/**', async (route) => forward(route, fake));
};
