import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { chromium, type Page, webkit } from '@playwright/test';

import type { CspException } from '../src/csp-exceptions.ts';
import { firstParty, recentLines, watch } from '../src/invariants.ts';
import { addressesOf, inStripeFrame, isStripeJs } from '../src/sandbox-stripe.ts';
import { onStripe } from '../src/stripe-checkout.ts';

await test('only a parsable URL on the origin is first-party', () => {
  const origin = 'https://site.test';
  const url = 'https://site.test/api/x';
  assert.equal(String(firstParty(url, origin)), url);
  assert.equal(firstParty('https://other.test/api/x', origin), undefined);
  assert.equal(firstParty('not a url', origin), undefined);
});

await test('the API log keeps only its last lines, in order, however many come', () => {
  const log = recentLines(20);
  assert.deepEqual(log.read(), []);
  for (let index = 0; index < 100_000; index += 1) {
    log.add(String(index));
  }
  assert.deepEqual(
    log.read(),
    Array.from({ length: 20 }, (_unused, index) => String(99_980 + index)),
  );
});

await test("only an https page on Stripe's own hosts is Stripe's", () => {
  assert.equal(onStripe('https://checkout.stripe.com/c/pay/cs_test'), true);
  assert.equal(onStripe('https://js.stripe.com/v3/'), true);
  assert.equal(onStripe('https://newassets.hcaptcha.com/captcha'), true);
  assert.equal(onStripe('https://pay.link.com/'), true, 'Link is Stripe’s');
  assert.equal(onStripe('https://notlink.com/'), false);
  assert.equal(onStripe('http://checkout.stripe.com/'), false);
  assert.equal(onStripe('https://payments-eu.amazon.com/alaMessage'), false);
  assert.equal(onStripe('https://notstripe.com/'), false);
  assert.equal(onStripe('https://app.test/?next=https://checkout.stripe.com/'), false);
  assert.equal(onStripe('about:blank'), false);
});

await test('only Stripe.js on its release train, and the files it puts on the page, are Stripe.js', () => {
  const at = 'https://js.stripe.com';
  assert.equal(isStripeJs(`${at}/endive/stripe.js`), true);
  assert.equal(isStripeJs(`${at}/v3/fingerprinted/js/custom-checkout-d180b0bd30f8.js`), true);
  assert.equal(isStripeJs(`${at}/v3/fingerprinted/css/elements-inner-payment-23e9b00b.css`), true);
  assert.equal(isStripeJs(`${at}/clover/stripe.js`), false, 'another release train');
  assert.equal(isStripeJs(`${at}/endive/stripe.js?key=pk_test`), false);
  assert.equal(isStripeJs(`${at}/v3/fingerprinted/img/visa-729c05c240c4.svg`), false);
  assert.equal(isStripeJs(`${at}/v3/fingerprinted/js/../../elsewhere.js`), false);
  assert.equal(isStripeJs('http://js.stripe.com/endive/stripe.js'), false);
  assert.equal(isStripeJs('https://api.stripe.com/endive/stripe.js'), false);
  assert.equal(isStripeJs('https://js.stripe.com.example.test/endive/stripe.js'), false);
  assert.equal(isStripeJs('not a url'), false);
});

/** Each page's document, as the routes below answer it: Stripe's frame opens a wallet's. */
const DOCUMENTS: Readonly<Record<string, string>> = {
  'https://app.test/':
    '<iframe src="https://js.stripe.com/v3/elements-inner-payment.html"></iframe><iframe src="https://video.example/embed"></iframe>',
  'https://js.stripe.com/v3/elements-inner-payment.html':
    '<iframe src="https://pay.google.com/gp/p/ui/payframe"></iframe>',
};

await test("a frame is Stripe's when it, or a frame it sits in, is on Stripe's hosts", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://**/*', async (route) =>
      route.fulfill({ contentType: 'text/html', body: DOCUMENTS[route.request().url()] ?? '' }),
    );
    await page.goto('https://app.test/');
    const judged = page
      .frames()
      .map((frame) => [new URL(frame.url()).host, inStripeFrame(frame)] as const);
    assert.deepEqual(
      new Map(judged),
      new Map([
        ['app.test', false],
        ['js.stripe.com', true],
        ['video.example', false],
        ['pay.google.com', true],
      ]),
    );
  } finally {
    await browser.close();
  }
});

await test('a console message is about where it was raised and the addresses it names', () => {
  const firefox =
    'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at https://pay.example/merchant?currency=GBP&domain=localhost. (Reason: CORS header missing). Status code: 200.';
  assert.deepEqual(addressesOf(firefox, ''), [
    '',
    'https://pay.example/merchant?currency=GBP&domain=localhost',
  ]);
  assert.deepEqual(
    addressesOf('Failed to load resource: net::ERR_FAILED', 'https://pay.example/a'),
    ['https://pay.example/a'],
  );
  assert.deepEqual(
    addressesOf('[JavaScript Error: "at https://a.example/b."]', 'https://c.example/'),
    ['https://c.example/', 'https://a.example/b'],
  );
});

/** A local site whose home page fetches `/hang`, answered only as the site closes, and whose
 *  other pages are blank. `asked` resolves as the fetch arrives. */
const hangingSite = async (): Promise<{
  origin: string;
  asked: Promise<ServerResponse>;
  close: () => void;
}> => {
  const asked = Promise.withResolvers<ServerResponse>();
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    const script = incoming.url === '/' ? "<script>fetch('/hang')</script>" : '';
    if (incoming.url === '/hang') {
      asked.resolve(outgoing);
    } else {
      outgoing.writeHead(200, { 'content-type': 'text/html' });
      outgoing.end(`<!doctype html><title>a</title>${script}`);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    asked: asked.promise,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

await test("a fetch cut off by its document's replacement is not counted, however late WebKit says so", async () => {
  const site = await hangingSite();
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    const invariants = await watch(page, {
      origin: site.origin,
      apiPrefix: undefined,
      notices: [],
    });
    // The page's one fetch is its one error, in whichever words the engine gives it.
    const refused = page.waitForEvent('pageerror');
    await page.goto(`${site.origin}/`);
    await site.asked;
    await page.goto(`${site.origin}/next`);
    await refused;
    assert.deepEqual(await invariants.take(), []);
  } finally {
    await browser.close();
    site.close();
  }
});

await test("a console message that includes one of the target's notices is not counted", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const notices = ['ResizeObserver loop'];
    const scope = { origin: 'https://site.test', apiPrefix: undefined, notices };
    const invariants = await watch(page, scope);
    const said = page.waitForEvent('console', (message) => message.text() === 'a real fault');
    await page.evaluate(() => {
      console.error('ResizeObserver loop completed with undelivered notifications.');
      console.error('a real fault');
    });
    await said;
    const found = await invariants.take();
    assert.deepEqual(
      found.map((problem) => problem.split(' (')[0]),
      ['console error: a real fault'],
    );
  } finally {
    await browser.close();
  }
});

/** A page under a style policy that refuses any inline style, with one written all the same. */
const STYLED = '<!doctype html><title>Styled</title><p style="color: red">styled</p>';

/** A site whose page breaks its own style policy, so the browser reports a real violation. */
const styleBreaker = async (): Promise<{ origin: string; close: () => void }> => {
  const site = createServer((_request, response: ServerResponse) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "style-src 'self'",
    });
    response.end(STYLED);
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const address = site.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => {
      site.close();
    },
  };
};

/** What the invariants find on the style-breaking page, under `exceptions`. */
const foundOnStyled = async (
  page: Page,
  origin: string,
  exceptions: NonNullable<Parameters<typeof watch>[1]['exceptions']>,
): Promise<string[]> => {
  const invariants = await watch(page, { origin, apiPrefix: undefined, notices: [], exceptions });
  const reported = page.waitForEvent('console', (message) =>
    message.text().startsWith('CSP violation'),
  );
  await page.goto(`${origin}/`);
  await reported;
  await page.evaluate(() => {
    console.error('CSP violation: script-src blocked inline');
  });
  const found = await invariants.take();
  return found.map((problem) => problem.split(' (')[0] ?? problem);
};

/** An exception for the page's own violation, on `engine`. */
const styleAttr = (engine: 'chromium' | 'webkit'): CspException => ({
  engine,
  directive: 'style-src-attr',
  blocked: 'inline',
  console: 'a Content Security Policy line this engine never writes',
  reason: 'the test’s own',
  bug: 'none',
  reviewBy: '2026-12-06',
});

await test('a CSP exception lets its violation pass on its engine alone, and is due once its day passes', async () => {
  const browser = await chromium.launch();
  const site = await styleBreaker();
  try {
    const onIts = await foundOnStyled(await browser.newPage(), site.origin, {
      list: [styleAttr('chromium')],
      engine: 'chromium',
      today: '2026-11-06',
    });
    // Its violation passes; the engine's own line, another violation, still count.
    assert.ok(
      !onIts.includes('console error: CSP violation: style-src-attr blocked inline'),
      onIts.join('\n'),
    );
    assert.ok(
      onIts.includes('console error: CSP violation: script-src blocked inline'),
      onIts.join('\n'),
    );
    assert.ok(
      onIts.some((problem) => problem.startsWith('console error: Applying inline style violates')),
      onIts.join('\n'),
    );
    const onAnother = await foundOnStyled(await browser.newPage(), site.origin, {
      list: [styleAttr('webkit')],
      engine: 'chromium',
      today: '2026-11-06',
    });
    assert.ok(
      onAnother.includes('console error: CSP violation: style-src-attr blocked inline'),
      onAnother.join('\n'),
    );
    const pastItsDay = await foundOnStyled(await browser.newPage(), site.origin, {
      list: [styleAttr('chromium')],
      engine: 'chromium',
      today: '2026-12-07',
    });
    assert.ok(
      pastItsDay.some((problem) => problem.startsWith("CSP exception refused: chromium's")),
      pastItsDay.join('\n'),
    );
  } finally {
    await browser.close();
    site.close();
  }
});

await test("an uncaught error that includes one of the target's notices is not counted", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const scope = {
      origin: 'https://site.test',
      apiPrefix: undefined,
      notices: ['ResizeObserver loop'],
    };
    const invariants = await watch(page, scope);
    const thrown = page.waitForEvent('pageerror', (error) => error.message === 'a real fault');
    await page.addScriptTag({
      content: "throw new Error('ResizeObserver loop completed with undelivered notifications.');",
    });
    await page.addScriptTag({ content: "throw new Error('a real fault');" });
    await thrown;
    assert.deepEqual(await invariants.take(), ['uncaught Error: a real fault']);
  } finally {
    await browser.close();
  }
});

/** A method to ask with, and the status the server answers it. */
type Ask = readonly [method: string, status: number];

/** Asks `/api/roster` with each of `asks` in turn, until the console has said what it says of a
 *  503. */
const askEach = async (page: Page, asks: readonly Ask[]): Promise<void> => {
  const [ask, ...rest] = asks;
  if (ask === undefined) {
    return;
  }
  const [method, status] = ask;
  const said = status === 503 ? page.waitForEvent('console') : Promise.resolve();
  await Promise.all([
    said,
    page.evaluate(async (asked) => {
      await fetch('/api/roster', { method: asked });
    }, method),
  ]);
  await askEach(page, rest);
};

/** The problems of a page on `https://site.test` that asks `/api/roster` with each of `asks` in
 *  turn, answered with its status. */
const problemsAsking = async (asks: readonly Ask[]): Promise<string[]> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const answers = asks.map(([, status]) => status);
    await page.route('https://site.test/', async (route) =>
      route.fulfill({ body: '<!doctype html><title>Roster</title>', contentType: 'text/html' }),
    );
    await page.route('https://site.test/api/roster', async (route) =>
      route.fulfill({ status: answers.shift() ?? 500, headers: { 'Retry-After': '0' } }),
    );
    const scope = { origin: 'https://site.test', apiPrefix: '/api', notices: [] };
    const invariants = await watch(page, scope);
    await page.goto('https://site.test/');
    await askEach(page, asks);
    const problems = await invariants.take();
    return problems.map((problem) => problem.split(' (')[0] ?? '').toSorted();
  } finally {
    await browser.close();
  }
};

/** What Chromium says of a request answered 503. */
const SAID_503 =
  'console error: Failed to load resource: the server responded with a status of 503';

await test('a 503 the page asked past, its request answered since, is not counted', async () => {
  assert.deepEqual(
    await problemsAsking([
      ['GET', 503],
      ['GET', 200],
    ]),
    [],
  );
});

await test('a 503 stands while its request was last answered 503, whatever else was', async () => {
  assert.deepEqual(
    await problemsAsking([
      ['GET', 503],
      ['POST', 200],
    ]),
    ['https://site.test/api/roster answered 503'],
  );
  assert.deepEqual(
    await problemsAsking([
      ['GET', 503],
      ['GET', 503],
    ]),
    [
      SAID_503,
      SAID_503,
      'https://site.test/api/roster answered 503',
      'https://site.test/api/roster answered 503',
    ],
  );
});
