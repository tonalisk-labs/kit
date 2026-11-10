import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';

import { type Busy, BUSY, waitedOut } from './busy.ts';
import { AXE, STRICTEST } from './checks/axe.ts';
import { invisibleFocusables } from './checks/focus.ts';
import { type OverlayAudit, overlayWatchScript } from './checks/overlays.ts';
import {
  type CspException,
  excepted,
  exceptionProblems,
  VIOLATION_WORDS,
} from './csp-exceptions.ts';
import { byOutcome, CANCELLED } from './image-outcomes.ts';
import { pointerWatchScript } from './keyboard.ts';
import { addressesOf, onStripePage, STRIPE_UNSEEN } from './sandbox-stripe.ts';
import { MEASURE_ENV } from './stack/control.ts';
import { sandboxRequested } from './stack/stripe-sandbox.ts';
import { onStripe } from './stripe-checkout.ts';
import { hearThirdParties } from './third-parties.ts';

/** What a page did wrong since the last look, and the API calls it made, as text. */
export interface Watch {
  readonly take: () => Promise<string[]>;
  /** Resolves once none of the page's first-party scripts is still loading: a page left
   *  sooner has its own imports cut off, which no visitor staying on it would see. */
  readonly scriptsLoaded: () => Promise<void>;
  /** The last API responses: method, URL, status and `Server-Timing`, most recent last. */
  readonly recentApi: () => readonly string[];
}

/** WebKit's words when a preloaded resource goes unused: "The resource <url> was preloaded…". */
const PRELOAD_UNUSED = ' was preloaded using link preload but not used';

const unusedPreload = (text: string): string | undefined =>
  text.startsWith('The resource ') && text.includes(PRELOAD_UNUSED)
    ? text.split(' ')[2]
    : undefined;

/** API responses kept for a failure report. */
const RECENT_API = 20;

/** Puts every CSP violation on the console, where the console invariant hears it. In the page. */
const reportViolations = (words: typeof VIOLATION_WORDS): void => {
  globalThis.document.addEventListener('securitypolicyviolation', (event) => {
    console.error(`${words.before}${event.violatedDirective}${words.between}${event.blockedURI}`);
  });
};

/** Firefox's advisory on any `height` or position write in a scroll handler, CodeMirror's
 *  one-task height lock as it redraws included; it names no element, so nothing can act on it. */
const SCROLL_LINKED_ADVISORY = '"This site appears to use a scroll-linked positioning effect.';

/** Firefox's words for a module import its document dropped as it was being replaced. */
const MODULE_DROPPED_IN_HANDOVER =
  /^\[JavaScript Warning: "Loading failed for the module with source “(?<url>[^”]+)”\."/u;

/** Where the console's problems go, what the page's documents fetched, and which of its own
 *  module URLs a document being replaced dropped. */
interface Heard {
  readonly fetches: Fetches;
  readonly droppedInHandover: (text: string) => boolean;
  readonly notices: readonly string[];
  /** Files a problem, or holds it until the image it names has settled. */
  readonly file: (url: string, problem: string) => void;
  /** Holds what is said of a 503 until the page has had the chance to ask again. */
  readonly busy: Busy;
  /** Whether a line is an engine's own CSP violation the target names as no fault of its own. */
  readonly excepted: (text: string) => boolean;
}

/** The URLs some document of the page fetched twice. */
interface Fetches {
  readonly duplicated: ReadonlySet<string>;
}

/** Whether a warning is WebKit's harmless unused preload: a document fetched the URL twice,
 *  since Vite preloads a module the page already ran. */
const harmlessPreload = (text: string, { duplicated }: Fetches): boolean => {
  const preloaded = unusedPreload(text);
  return preloaded !== undefined && duplicated.has(preloaded);
};

/** Files a console error or warning as a problem, bar the known, harmless ones. */
const hear = (
  message: ConsoleMessage,
  { fetches, droppedInHandover, notices, file, busy, excepted: exempt }: Heard,
): void => {
  if (message.type() !== 'error' && message.type() !== 'warning') {
    return;
  }
  const text = message.text();
  const { url, lineNumber } = message.location();
  if (
    notices.some((notice) => text.includes(notice)) ||
    exempt(text) ||
    harmlessPreload(text, fetches) ||
    droppedInHandover(text) ||
    text.includes(SCROLL_LINKED_ADVISORY)
  ) {
    return;
  }
  const filing = busy.said(text) ? busy.hold : file;
  filing(url, `console ${message.type()}: ${text} (${url}:${String(lineNumber)})`);
};

/** URLs a single document of the page requested twice, counted outside the page as a fake clock
 *  stubs its timings. A new document starts with its own request; a history change makes none. */
const watchFetches = (page: Page): Fetches => {
  const fetched = new Set<string>();
  const duplicated = new Set<string>();
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      fetched.clear();
    }
    if (fetched.has(request.url())) {
      duplicated.add(request.url());
    }
    fetched.add(request.url());
  });
  return { duplicated };
};

/** WebKit's words for a fetch refused while its document is being replaced. */
const REFUSED_IN_HANDOVER = /^Fetch API cannot load (?<url>\S+) due to access control checks\.$/u;

/** A refusal with no error name before it, which Playwright splits at the URL's `://`. */
const REFUSED_SCHEME = /^Fetch API cannot load [a-z]+$/u;

const refusedUrl = ({ name, message }: Error): string => {
  const text = REFUSED_SCHEME.test(name) ? `${name}:/${message}` : message;
  const match = REFUSED_IN_HANDOVER.exec(text);
  if (match === null) {
    return '';
  }
  const { groups = {} } = match;
  return groups['url'] ?? '';
};

/** Whether a navigation is under way, or a request `cut` accepts was cut off for a document since
 *  replaced. */
type Handover = (cut: (url: string) => boolean) => boolean;

/** WebKit's words for a fetch it cancelled, which name no URL. */
const LOAD_FAILED = /\bTypeError: Load failed$/u;

/** A refusal of one of the page's own fetches that its document's replacement explains: named,
 *  or WebKit's unnamed failure once one of the page's own requests was cut off. */
const refusedInHandover = (
  error: Error,
  handedOver: Handover,
  ours: (url: string) => boolean,
): boolean => {
  if (LOAD_FAILED.test(`${error.name}: ${error.message}`)) {
    return handedOver(ours);
  }
  const url = refusedUrl(error);
  return ours(url) && handedOver((cut) => cut === url);
};

/** The main frame's hand-over between documents: a navigation under way, and the URLs the
 *  browser cancelled for a document it replaced, whose refusals it may report after the commit. */
const watchHandover = (page: Page): Handover => {
  const state = { navigating: false, document: 0 };
  const madeBy = new WeakMap<Request, number>();
  const cutOff = new Set<string>();
  const navigation = (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  page.on('request', (request) => {
    madeBy.set(request, state.document);
    state.navigating ||= navigation(request);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && state.navigating) {
      state.navigating = false;
      state.document += 1;
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    const replaced = state.navigating || madeBy.get(request) !== state.document;
    if (navigation(request)) {
      state.navigating = false;
    } else if (replaced && failure !== null && CANCELLED.test(failure.errorText)) {
      cutOff.add(request.url());
    }
  });
  page.on('requestfinished', (request) => {
    cutOff.delete(request.url());
  });
  return (cut) => state.navigating || [...cutOff].some((url) => cut(url));
};

/** Firefox's counterpart of WebKit's refused fetch: one of the page's own imports, cut off
 *  while its document was being replaced. */
const droppedModule =
  (handedOver: Handover, ours: (url: string) => boolean) =>
  (text: string): boolean => {
    const { groups = {} } = MODULE_DROPPED_IN_HANDOVER.exec(text) ?? {};
    const url = groups['url'] ?? '';
    return ours(url) && handedOver((cut) => cut === url);
  };

/** Each engine's words for a module import its document gave up: Firefox names the module,
 *  WebKit does not. */
const IMPORT_FAILED =
  /^TypeError: error loading dynamically imported module: (?<url>\S+)$|^Unhandled Promise Rejection: TypeError: Importing a module script failed\.$/u;

/** An import cut off as its document is replaced: navigation started, not committed, and the
 *  browser cancelled, unsent, a first-party script of this document (the one named, if named). */
const cutImport = (page: Page, ours: (url: string) => boolean): ((error: Error) => boolean) => {
  const state = { leaving: false, cancelled: new Set<string>() };
  const mainNavigation = (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  page.on('request', (request) => {
    state.leaving ||= mainNavigation(request);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      state.leaving = false;
      state.cancelled.clear();
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    const unsent = request.timing().requestStart === -1;
    const cancelled = failure !== null && CANCELLED.test(failure.errorText);
    if (mainNavigation(request)) {
      state.leaving = false;
    } else if (request.resourceType() === 'script' && ours(request.url()) && cancelled && unsent) {
      state.cancelled.add(request.url());
    }
  });
  return (error) => {
    const match = IMPORT_FAILED.exec(`${error.name}: ${error.message}`);
    if (match === null || !state.leaving) {
      return false;
    }
    const { groups: { url } = {} } = match;
    return url === undefined ? state.cancelled.size > 0 : state.cancelled.has(url);
  };
};

/** The first-party scripts the page has asked for and not yet received or given up. */
const watchScripts = (page: Page, ours: (url: string) => boolean): (() => Promise<void>) => {
  const loading = new Set<Request>();
  const waiting: ((value: boolean) => void)[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script' && ours(request.url())) {
      loading.add(request);
    }
  });
  const settle = (request: Request): void => {
    if (loading.delete(request) && loading.size === 0) {
      for (const resolve of waiting.splice(0)) {
        resolve(true);
      }
    }
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  return async () => {
    if (loading.size === 0) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    waiting.push(resolve);
    await promise;
  };
};

const hearErrors = (page: Page, problems: string[], excused: (error: Error) => boolean): void => {
  page.on('pageerror', (error) => {
    if (!excused(error)) {
      problems.push(`uncaught ${error.name}: ${error.message}`);
    }
  });
};

const describeApi = async (response: Response): Promise<string> => {
  const timing = await response.headerValue('server-timing');
  const method = response.request().method();
  return `${method} ${response.url()} → ${String(response.status())}${timing === null ? '' : ` (Server-Timing: ${timing})`}`;
};

interface Scope {
  readonly origin: string;
  /** The path prefix of first-party API calls, if the target has an API. */
  readonly apiPrefix: string | undefined;
  /** What the target's browsers write that is no fault of it (the adapter's `notices`). */
  readonly notices: readonly string[];
  /** A keyboard-only test's: any pointer press, touch or wheel turn the page hears is a problem. */
  readonly keyboardOnly?: boolean;
  /** The target's CSP exceptions, the engine this page runs on, and the day, as `YYYY-MM-DD`. */
  readonly exceptions?: {
    readonly list: readonly CspException[];
    readonly engine: string;
    readonly today: string;
  };
}

/** The page function an opening overlay's findings reach the watch by. */
const OVERLAY_BINDING = '__sitesTestingOverlay';

/** The page functions that load axe-core for an opening overlay, and take what it finds. */
const OVERLAY_AXE_LOAD = '__sitesTestingOverlayAxeLoad';
const OVERLAY_AXE = '__sitesTestingOverlayAxe';

/** The page function a keyboard-only page names each pointer press to. */
const POINTER_BINDING = '__sitesTestingPointer';

/** Files what keeps each overlay from showing whole once its entry has played, and what axe-core
 *  finds in it, bar on Stripe's pages; a measuring run leaves axe-core out of its steps. */
const hearOverlays = async (page: Page, problems: string[]): Promise<void> => {
  await page.exposeFunction(OVERLAY_BINDING, (finding: string) => {
    if (!onStripePage(page)) {
      problems.push(`overlay not shown whole: ${finding}`);
    }
  });
  const measuring = process.env[MEASURE_ENV] === '1';
  const audit: OverlayAudit | undefined = measuring
    ? undefined
    : { load: OVERLAY_AXE_LOAD, report: OVERLAY_AXE, options: STRICTEST };
  if (audit !== undefined) {
    await page.exposeBinding(OVERLAY_AXE_LOAD, async ({ frame }) => {
      await frame.evaluate(AXE);
    });
    await page.exposeFunction(OVERLAY_AXE, (finding: string) => {
      if (!onStripePage(page)) {
        problems.push(`overlay fails axe-core: ${finding}`);
      }
    });
  }
  const watch =
    audit === undefined ? { binding: OVERLAY_BINDING } : { binding: OVERLAY_BINDING, audit };
  await page.addInitScript({ content: overlayWatchScript(watch) });
};

/** Files each pointer press, touch or wheel turn a keyboard-only test's page hears. */
const hearPointers = async (page: Page, problems: string[]): Promise<void> => {
  await page.exposeFunction(POINTER_BINDING, (heard: string) => {
    problems.push(`a keyboard-only test used a pointer: ${heard}`);
  });
  await page.addInitScript({ content: pointerWatchScript(POINTER_BINDING) });
};

export const firstParty = (address: string, origin: string): URL | undefined => {
  if (!URL.canParse(address)) {
    return undefined;
  }
  const url = new URL(address);
  return url.origin === origin ? url : undefined;
};

/** Hears the page's console, bar what Stripe says on its pages, and under the opt-in sandbox in its
 *  frames on the app's page and of its own requests, as a wallet refused on a test host. */
const hearConsole = (page: Page, heard: Heard, asked: ReadonlySet<string>): void => {
  const byStripeFrames = (message: ConsoleMessage): boolean => {
    const { url } = message.location();
    return (
      sandboxRequested() &&
      (onStripe(url) || addressesOf(message.text(), url).some((at) => asked.has(at)))
    );
  };
  page.on('console', (message) => {
    if (!onStripePage(page) && !byStripeFrames(message)) {
      hear(message, heard);
    }
  });
};

/** A log that keeps its last `limit` lines, as only those are ever read. */
export const recentLines = (
  limit: number,
): { readonly add: (line: string) => void; readonly read: () => string[] } => {
  const lines: string[] = [];
  return {
    add: (line) => {
      lines.push(line);
      if (lines.length > limit) {
        lines.shift();
      }
    },
    read: () => [...lines],
  };
};

/** Flags first-party assets that answered an error, a 503 once the page never got past it, and
 *  logs the API calls; answers the log. */
const hearResponses = (
  page: Page,
  scope: Scope,
  { problems, busy }: { readonly problems: string[]; readonly busy: Busy },
): (() => string[]) => {
  const api = recentLines(RECENT_API);
  page.on('response', (response) => {
    const address = response.url();
    const url = firstParty(address, scope.origin);
    const asset = response.request().resourceType() !== 'document';
    const status = response.status();
    if (asset && url !== undefined && status >= 400) {
      const problem = `${address} answered ${String(status)}`;
      if (status === BUSY) {
        busy.hold(address, problem, response.request().method());
      } else {
        problems.push(problem);
      }
    }
    if (
      url !== undefined &&
      scope.apiPrefix !== undefined &&
      url.pathname.startsWith(`${scope.apiPrefix}/`)
    ) {
      describeApi(response)
        .then(api.add)
        .catch((error: unknown) => {
          api.add(`${address}: ${String(error)}`);
        });
    }
  });
  return api.read;
};

/** Files each first-party request that failed, bar one the page called off. */
const hearFailures = (page: Page, ours: (url: string) => boolean, problems: string[]): void => {
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    const cancelled = failure !== null && CANCELLED.test(failure.errorText);
    if (ours(request.url()) && !cancelled) {
      problems.push(
        `${request.method()} ${request.url()} failed: ${failure === null ? '' : failure.errorText}`,
      );
    }
  });
};

/** Holds a page to every test's invariants: no console problem, page error, CSP violation, failed
 *  request, 503 not got past, unseen focus or flawed overlay, and no pointer in a keyboard test. */
export const watch = async (page: Page, scope: Scope): Promise<Watch> => {
  const problems: string[] = [];
  const fetches = watchFetches(page);
  const handedOver = watchHandover(page);
  const ours = (url: string): boolean => firstParty(url, scope.origin) !== undefined;
  await page.addInitScript(reportViolations, VIOLATION_WORDS);
  await hearOverlays(page, problems);
  if (scope.keyboardOnly === true) {
    await hearPointers(page, problems);
  }
  const droppedInHandover = droppedModule(handedOver, ours);
  const importCut = cutImport(page, ours);
  const outcomes = byOutcome(page, problems);
  const busy = waitedOut(page, problems);
  const thirdParties = hearThirdParties(page, scope.origin, problems);
  const { list, engine, today } = scope.exceptions ?? { list: [], engine: '', today: '' };
  const heard = {
    fetches,
    droppedInHandover,
    notices: scope.notices,
    file: outcomes.file,
    busy,
    excepted: (text: string): boolean => excepted(list, { engine, today }, text),
  };
  hearConsole(page, heard, thirdParties.asked);
  hearErrors(
    page,
    problems,
    (error) =>
      scope.notices.some((notice) => error.message.includes(notice)) ||
      onStripePage(page) ||
      refusedInHandover(error, handedOver, ours) ||
      importCut(error),
  );
  hearFailures(page, ours, problems);
  const recentApi = hearResponses(page, scope, { problems, busy });
  return {
    take: async () => {
      await Promise.all([thirdParties.judged(), outcomes.judged()]);
      busy.judged();
      const exempt = sandboxRequested() ? STRIPE_UNSEEN : undefined;
      const hidden = page.isClosed() ? [] : await invisibleFocusables(page, exempt);
      return [...exceptionProblems(list, today), ...problems.splice(0), ...hidden];
    },
    recentApi,
    scriptsLoaded: watchScripts(page, ours),
  };
};
