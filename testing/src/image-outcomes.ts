// What is said of an image is judged once its load settles, by the load's own outcome: the
// console and the request's failure reach the watch in either order.
import type { Page, Request } from '@playwright/test';

/** A request the page itself called off (an AbortController, a closed view): each engine's
 *  words for it. Nothing failed; the page stopped wanting the answer. */
export const CANCELLED =
  /^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u;

interface Outcomes {
  /** Files a problem, or holds it until the image it names has settled. */
  readonly file: (url: string, problem: string) => void;
  readonly judged: () => Promise<void>;
}

/** Each image load's outcome by URL, the latest load's: the navigations started before it when the
 *  page cancelled it, else undefined. Firefox also calls a corrupt or truncated image cancelled. */
const imageOutcomes = (
  page: Page,
): {
  readonly outcomes: ReadonlyMap<string, Promise<number | undefined>>;
  readonly started: () => number;
} => {
  const navigations = { started: 0 };
  const outcomes = new Map<string, Promise<number | undefined>>();
  const pending = new WeakMap<Request, (cancelled: boolean) => void>();
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigations.started += 1;
    } else if (request.resourceType() === 'image') {
      const at = navigations.started;
      const outcome = new Promise<number | undefined>((done) => {
        pending.set(request, (cancelled) => {
          done(cancelled ? at : undefined);
        });
      });
      outcomes.set(request.url(), outcome);
    }
  });
  const settled = (request: Request, cancelled: boolean): void => {
    const done = pending.get(request);
    if (done !== undefined) {
      done(cancelled);
    }
  };
  page.on('requestfinished', (request) => {
    settled(request, false);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    settled(request, failure !== null && CANCELLED.test(failure.errorText));
  });
  return { outcomes, started: () => navigations.started };
};

/** Files what is said of an image as the problems are taken, unless the page cancelled its load and
 *  a navigation began since (Firefox may report the cancellation before that navigation). */
export const byOutcome = (page: Page, problems: string[]): Outcomes => {
  const { outcomes, started } = imageOutcomes(page);
  const held: { readonly outcome: Promise<number | undefined>; readonly problem: string }[] = [];
  return {
    file: (url, problem) => {
      const outcome = outcomes.get(url);
      if (outcome === undefined) {
        problems.push(problem);
      } else {
        held.push({ outcome, problem });
      }
    },
    judged: async () => {
      const judging = held.splice(0);
      const starts = await Promise.all(judging.map(async ({ outcome }) => outcome));
      problems.push(
        ...judging
          .filter((_held, at) => {
            const start = starts[at];
            return start === undefined || started() <= start;
          })
          .map(({ problem }) => problem),
      );
    },
  };
};
