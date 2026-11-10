// Under the opt-in Stripe sandbox (STRIPE_SANDBOX=1), what Stripe does on a page under test,
// which the invariants leave to Stripe: its own pages, its frames on the app's page and the frames
// they open, Stripe.js as the page loads it, and the one frame of Stripe's that takes focus unseen.
import type { Frame, Page, Request } from '@playwright/test';

import { RELEASE_TRAIN } from './stack/stripe-js.ts';
import { sandboxRequested } from './stack/stripe-sandbox.ts';
import { onStripe } from './stripe-checkout.ts';

/** Whether `frame` is one of Stripe's, or sits inside one: a frame Stripe's frames open, a
 *  wallet's or a captcha's, does Stripe's work, from before its own document arrives. */
export const inStripeFrame = (frame: Frame | null): boolean =>
  frame !== null && (onStripe(frame.url()) || inStripeFrame(frame.parentFrame()));

/** The addresses a console message is about: where it was raised, and those its text names. */
export const addressesOf = (text: string, at: string): string[] => [
  at,
  ...[...text.matchAll(/https?:\/\/[^\s"'()<>]+/gu)].map(([named]) => named.replace(/\.+$/u, '')),
];

/** The frame Stripe keeps on the page for Link's modal: in the tab order, at no size, until the
 *  modal opens. It's Stripe's to fix, and holds nothing until then. */
export const STRIPE_UNSEEN = 'iframe[src^="https://js.stripe.com/v3/universal-link-modal-inner-"]';

/** Where Stripe.js is served from, on its release train, and the fingerprinted scripts and
 *  stylesheets it puts on the page for its frames. */
const STRIPE_JS = new RegExp(
  `^/(?:${RELEASE_TRAIN}/stripe\\.js|v3/fingerprinted/(?:js/[\\w-]+\\.js|css/[\\w-]+\\.css))$`,
  'u',
);

/** Whether `address` is Stripe.js, or a file it loads into the page that runs it. */
export const isStripeJs = (address: string): boolean => {
  if (!URL.canParse(address)) {
    return false;
  }
  const { protocol, host, pathname, search } = new URL(address);
  return (
    protocol === 'https:' && host === 'js.stripe.com' && search === '' && STRIPE_JS.test(pathname)
  );
};

/** Under the opt-in sandbox, whether the page's top-level document is one of Stripe's pages:
 *  whatever happens on the page then is Stripe's doing, never the app's. */
export const onStripePage = (page: Page): boolean => sandboxRequested() && onStripe(page.url());

/** Whether Stripe made a request, judged as it is sent: on Stripe's page, from its worker or
 *  frames, a navigation to one of its pages, or Stripe.js and the files it loads for its frames. */
export const byStripe = (page: Page, request: Request): boolean => {
  const worker = request.serviceWorker();
  const asking = worker === null ? inStripeFrame(request.frame()) : onStripe(worker.url());
  const toStripe = request.isNavigationRequest() && onStripe(request.url());
  const stripeJs = isStripeJs(request.url());
  return onStripePage(page) || (sandboxRequested() && (asking || toStripe || stripeJs));
};
