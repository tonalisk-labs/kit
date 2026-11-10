// A server at capacity answers 503 and says when to come back, and the page asks again once it
// has waited. What is said of a 503 is judged as the problems are taken, by the latest answer to
// the same request: it stands only while that answer is still 503.
import type { Page } from '@playwright/test';

/** What a server at capacity answers. */
export const BUSY = 503;

/** Chromium's and WebKit's words on the console for a request answered 503, at its URL. */
const SAID_BUSY = /^Failed to load resource: the server responded with a status of 503\b/u;

export interface Busy {
  /** Whether the console's words are of a request answered 503. */
  readonly said: (text: string) => boolean;
  /** Holds a problem with a 503 until the problems are taken: by its request's method and URL, or
   *  by its URL alone for the console, which names no method. */
  readonly hold: (url: string, problem: string, method?: string) => void;
  /** Files each held problem whose request was last answered 503. */
  readonly judged: () => void;
}

/** Files what is said of a 503 as the problems are taken, unless the page asked again since and
 *  was answered. */
export const waitedOut = (page: Page, problems: string[]): Busy => {
  const byRequest = new Map<string, number>();
  const byUrl = new Map<string, number>();
  page.on('response', (response) => {
    const url = response.url();
    byRequest.set(`${response.request().method()} ${url}`, response.status());
    byUrl.set(url, response.status());
  });
  const held: { readonly problem: string; readonly url: string; readonly method?: string }[] = [];
  return {
    said: (text) => SAID_BUSY.test(text),
    hold: (url, problem, method) => {
      held.push(method === undefined ? { problem, url } : { problem, url, method });
    },
    judged: () => {
      problems.push(
        ...held
          .splice(0)
          .filter(({ url, method }) =>
            method === undefined
              ? byUrl.get(url) === BUSY
              : byRequest.get(`${method} ${url}`) === BUSY,
          )
          .map(({ problem }) => problem),
      );
    },
  };
};
