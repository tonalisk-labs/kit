// A test is stuck once nothing has moved for STILL_MS: no request, answer, console line, navigation
// or socket frame, and no work of the worker's own. A test that moves, however slowly a loaded
// machine makes it, is never stopped here; config.ts's fixed bound is only the backstop for one
// that keeps moving for ever.
import type { BrowserContext, Page, TestInfo } from '@playwright/test';

import { type Clock, STILLNESS } from './stack/stall.ts';

/** How long nothing heard may move: 2.5 times the longest a test still moving went unheard under
 *  load, 52.5 s, as WebKit's actions crawled on a starved Linux image with no request between. */
export const STILL_MS = 132_000;

/** Work of the worker's own, as a share of a core over the stretch: Testbed's Watch's 5 ms in 5 s.
 *  An idle worker spends about a ninth of it, an action or a Lighthouse report far more. */
const WORKING_SHARE = 0.001;

/** The test's watch: told of each thing that moves, and stopped as the test ends. */
export interface Progress {
  readonly moved: (what: string) => void;
  readonly stop: () => void;
}

export interface Watching {
  /** Called once, naming what last moved, when nothing has for `stillMs`. */
  readonly stuck: (last: string) => void;
  readonly stillMs?: number;
  readonly clock?: Clock;
  /** The worker's processor time so far, in µs. */
  readonly spent?: () => number;
}

const workerSpent = (): number => {
  const { user, system } = process.cpuUsage();
  return user + system;
};

/** One alarm, set again by each thing that moves; ringing, it reads the worker's processor time
 *  once, and sets itself again if the worker worked, else calls the test stuck. */
export const watchProgress = ({
  stuck,
  stillMs = STILL_MS,
  clock = STILLNESS.clock,
  spent = workerSpent,
}: Watching): Progress => {
  const state = {
    last: 'the test began',
    since: 0,
    cancel: (): void => undefined,
    done: false,
  };
  const arm = (): void => {
    state.cancel();
    state.since = spent();
    state.cancel = clock.after(stillMs, () => {
      if (spent() - state.since >= stillMs * 1000 * WORKING_SHARE) {
        arm();
      } else {
        state.done = true;
        stuck(state.last);
      }
    });
  };
  arm();
  return {
    moved: (what) => {
      if (!state.done) {
        state.last = what;
        arm();
      }
    },
    stop: () => {
      state.done = true;
      state.cancel();
    },
  };
};

/** A page's own progress: its navigations and its sockets' frames each way. */
const hearPage = (page: Page, progress: Progress): void => {
  page.on('framenavigated', (frame) => {
    progress.moved(`navigated to ${frame.url()}`);
  });
  page.on('websocket', (socket) => {
    socket.on('framesent', () => {
      progress.moved(`a frame sent on ${socket.url()}`);
    });
    socket.on('framereceived', () => {
      progress.moved(`a frame received on ${socket.url()}`);
    });
  });
};

/** A context's progress: each request begun, answered, finished or failed, each console line, and
 *  its pages', those it has and those it opens. */
export const hearProgress = (context: BrowserContext, progress: Progress): void => {
  context.on('request', (request) => {
    progress.moved(`${request.method()} ${request.url()} sent`);
  });
  context.on('response', (response) => {
    progress.moved(`${response.request().method()} ${response.url()} answered`);
  });
  context.on('requestfinished', (request) => {
    progress.moved(`${request.method()} ${request.url()} finished`);
  });
  context.on('requestfailed', (request) => {
    progress.moved(`${request.method()} ${request.url()} failed`);
  });
  context.on('console', (message) => {
    progress.moved(`the console said ${message.type()}`);
  });
  for (const page of context.pages()) {
    hearPage(page, progress);
  }
  context.on('page', (page) => {
    hearPage(page, progress);
  });
};

/** Ends a stuck test now, through its own timeout, the open step's call log in Playwright's
 *  report; `ranMs` is how long it has run, so the timeout it names is close to the truth. */
export const endStuck = (testInfo: TestInfo, ranMs: number): void => {
  testInfo.setTimeout(Math.max(1, ranMs));
};

/** What a stuck test's teardown says: what stood still, and since what. */
export const stuckProblem = (last: string, stillMs: number = STILL_MS): Error =>
  new Error(`the test stood still for ${String(stillMs / 1000)} s: nothing moved after ${last}`);
