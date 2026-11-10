// Stripe's hosted Checkout in test mode, as a person pays on it: the card's fold when it offers
// several ways to pay, then a test card. For sandbox journeys (STRIPE_SANDBOX=1) only.
import { expect, type Locator, type Page } from '@playwright/test';

/** Stripe's documented test card that is always paid. */
export const PAID_CARD = '4242424242424242';

/** Where Stripe's hosted Checkout lives. */
export const STRIPE_CHECKOUT = /^https:\/\/checkout\.stripe\.com\//u;

/** A line from Stripe's own pages, or the hCaptcha they embed: their console is Stripe's. */
export const STRIPE_HOSTED =
  /https:\/\/(?:[\w-]+\.)*(?:stripe\.com|stripe\.network|stripecdn\.com|hcaptcha\.com|link\.com)\b/u;

/** The hosts of Stripe's own pages and frames, Link's and the hCaptcha they embed among them. */
const STRIPE_HOSTS =
  /(?:^|\.)(?:stripe\.com|stripe\.network|stripecdn\.com|hcaptcha\.com|link\.com)$/u;

/** Whether the document or worker at `address` is Stripe's own, judged by its origin alone. */
export const onStripe = (address: string): boolean => {
  if (!URL.canParse(address)) {
    return false;
  }
  const { protocol, hostname } = new URL(address);
  return protocol === 'https:' && STRIPE_HOSTS.test(hostname);
};

export interface CheckoutForm {
  readonly email: Locator;
  readonly number: Locator;
  readonly expiry: Locator;
  readonly cvc: Locator;
  readonly name: Locator;
  readonly country: Locator;
  readonly postal: Locator;
  /** The card's fold, shown when Checkout offers more than one way to pay. */
  readonly card: Locator;
  readonly pay: Locator;
}

/** Stripe's hosted Checkout, by the ids and test ids Stripe gives its own fields. */
export const checkoutForm = (page: Page): CheckoutForm => ({
  email: page.locator('#email'),
  number: page.locator('#cardNumber'),
  expiry: page.locator('#cardExpiry'),
  cvc: page.locator('#cardCvc'),
  name: page.locator('#billingName'),
  country: page.locator('#billingCountry'),
  postal: page.locator('#billingPostalCode'),
  card: page.getByRole('main').getByText('Card', { exact: true }),
  pay: page.getByTestId('hosted-payment-submit-button'),
});

/** The payment methods render after the email: the card's fold, or its fields directly. */
export const chooseTheCard = async (form: CheckoutForm): Promise<void> => {
  await expect(form.card.or(form.number).first()).toBeVisible();
  if (!(await form.number.isVisible())) {
    // Checkout lays a transparent button over the row: the click lands on it, as a person's does.
    await form.card.click({ force: true });
    await expect(form.number).toBeVisible();
  }
};

/** Fills in `card` with a future expiry and any CVC, as Stripe's test cards take. */
export const fillCard = async (form: CheckoutForm, card: string): Promise<void> => {
  await form.number.fill(card);
  await form.expiry.fill('12 / 34');
  await form.cvc.fill('123');
};

/** Pays on the Checkout page the browser is on, by card, under `name`, and presses Pay. */
export const payAtSandboxCheckout = async (
  page: Page,
  { card = PAID_CARD, name }: { readonly card?: string; readonly name: string },
): Promise<void> => {
  const form = checkoutForm(page);
  await chooseTheCard(form);
  await fillCard(form, card);
  await form.name.fill(name);
  // The country follows the name when Checkout asks for one; the button is there either way.
  await expect(form.country.or(form.pay).first()).toBeVisible();
  if (await form.country.isVisible()) {
    await form.country.selectOption('PT');
  }
  await form.pay.click();
};
