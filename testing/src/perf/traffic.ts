import type { BrowserContext, Page, Request, Response, WebSocket } from '@playwright/test';

/** One kind of live socket's frames and payload bytes, each way. */
interface Channel {
  frames: number;
  up: number;
  down: number;
}

/** One HTTP request: when the browser started it (epoch ms), what it was, and its bytes. */
export interface Exchange {
  readonly at: number;
  readonly path: string;
  readonly label: string;
  up: number;
  down: number;
  readonly failed: boolean;
}

/** A context's traffic over one step: HTTP by Playwright's own sizes, sockets by their frames. */
export interface Tally {
  /** The requests the step started, each once it has finished or failed. Request heads and
   *  bodies up; response heads and bodies down, as encoded on the wire. */
  readonly exchanges: Exchange[];
  /** Live sockets' payload bytes, each way, and the sockets opened. */
  socketUp: number;
  socketDown: number;
  sockets: number;
  readonly channels: Record<string, Channel>;
  /** Requests started so far, finished or not. */
  started: number;
}

/** The longest the traffic may take to settle before the step fails naming what it waits on. */
const SETTLE_MS = 60_000;

/** Fails with `what` if `promise` hasn't settled within SETTLE_MS: a bound on an event wait,
 *  never a wait of its own. */
const bounded = async <Value>(promise: Promise<Value>, what: () => string): Promise<Value> => {
  const timer: { id?: NodeJS.Timeout } = {};
  const expired = new Promise<never>((_resolve, reject) => {
    timer.id = setTimeout(() => {
      reject(new Error(`traffic did not settle in ${String(SETTLE_MS)} ms: ${what()}`));
    }, SETTLE_MS);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer.id);
  }
};

export interface Traffic {
  /** The current step's traffic, once every request it started has finished and been sized;
   *  the next step starts afresh. */
  readonly take: () => Promise<Tally>;
  /** Resolves once every HTTP request of the context has its answer, or failed. */
  readonly settled: () => Promise<void>;
  /** Resolves once every request the current step started has finished or failed. */
  readonly finished: () => Promise<void>;
  readonly started: () => number;
  readonly stop: () => void;
}

/** The channel a socket's frames count under; `other` for any the caller did not name. */
const channelOf = (channels: Readonly<Record<string, RegExp>>, url: string): string => {
  const { pathname } = new URL(url);
  const [name = 'other'] =
    Object.entries(channels).find(([, pattern]) => pattern.test(pathname)) ?? [];
  return name;
};

const freshTally = (channels: Readonly<Record<string, RegExp>>): Tally => ({
  exchanges: [],
  socketUp: 0,
  socketDown: 0,
  sockets: 0,
  started: 0,
  channels: Object.fromEntries(
    [...Object.keys(channels), 'other'].map((name) => [name, { frames: 0, up: 0, down: 0 }]),
  ),
});

const sizeOf = (payload: string | Buffer): number =>
  typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;

const isWeb = (request: Request): boolean => /^https?:/u.test(request.url());

interface Watch {
  readonly channels: Readonly<Record<string, RegExp>>;
  current: Tally;
  /** Sizes still to come, by the step they count in. */
  readonly pending: Map<Promise<void>, Tally>;
  /** Requests waiting for their answer, and those whose body has not finished yet. */
  readonly answering: Set<Request>;
  readonly unfinished: Set<Request>;
  /** Waits rechecked whenever a request moves on. */
  readonly waiters: Set<() => void>;
  /** The step each request started in, and the steps already reported. */
  readonly startedIn: WeakMap<Request, Tally>;
  readonly taken: WeakSet<Tally>;
}

const changed = (watch: Watch): void => {
  for (const waiter of watch.waiters) {
    waiter();
  }
};

/** Resolves once `done` holds, rechecked as requests move on; fails naming `what` past the bound. */
const until = async (watch: Watch, done: () => boolean, what: () => string): Promise<void> => {
  if (done()) {
    return;
  }
  const waiting: { check?: () => void } = {};
  try {
    await bounded(
      new Promise<void>((resolve) => {
        waiting.check = (): void => {
          if (done()) {
            resolve();
          }
        };
        watch.waiters.add(waiting.check);
      }),
      what,
    );
  } finally {
    if (waiting.check !== undefined) {
      watch.waiters.delete(waiting.check);
    }
  }
};

const answered = (watch: Watch, request: Request): void => {
  watch.answering.delete(request);
  changed(watch);
};

/** The step a request counts in: the one it started in, unless that one was already reported. */
const stepOf = (watch: Watch, request: Request): Tally => {
  const started = watch.startedIn.get(request);
  return started === undefined || watch.taken.has(started) ? watch.current : started;
};

const urlsOf = (requests: Iterable<Request>): string =>
  [...requests].map((request) => request.url()).join(', ');

/** Counts a socket's frames under its channel, in whichever step is current when each comes. */
const watchSocket = (watch: Watch, socket: WebSocket): void => {
  const name = channelOf(watch.channels, socket.url());
  watch.current.sockets += 1;
  const count = (payload: string | Buffer, way: 'up' | 'down'): void => {
    const channel = watch.current.channels[name];
    if (channel !== undefined) {
      channel.frames += 1;
      channel[way] += sizeOf(payload);
      watch.current[way === 'up' ? 'socketUp' : 'socketDown'] += sizeOf(payload);
    }
  };
  socket.on('framesent', ({ payload }) => {
    count(payload, 'up');
  });
  socket.on('framereceived', ({ payload }) => {
    count(payload, 'down');
  });
};

const ownUnfinished = (watch: Watch): Request[] =>
  [...watch.unfinished].filter((request) => watch.startedIn.get(request) === watch.current);

const take = async (watch: Watch): Promise<Tally> => {
  await until(
    watch,
    () => ownUnfinished(watch).length === 0,
    () => `bodies of ${urlsOf(ownUnfinished(watch))}`,
  );
  // The next step starts before the wait for sizes, so a request begun in it counts there.
  const taken = watch.current;
  watch.current = freshTally(watch.channels);
  watch.taken.add(taken);
  const sizing = [...watch.pending].filter(([, tally]) => tally === taken);
  for (const [sized] of sizing) {
    watch.pending.delete(sized);
  }
  await bounded(Promise.all(sizing.map(async ([sized]) => sized)), () => 'request sizes');
  return taken;
};

/** What a request is, as a document's change judges it. */
export interface Seen {
  readonly serviceWorker: () => unknown;
  readonly isNavigationRequest: () => boolean;
  readonly frame: () => { readonly page: () => unknown };
}

/** Whether a request died unreported as the main frame committed a new document: any the old one
 *  made but its navigations, and an unanswered navigation the new one superseded. */
export const staleOnCommit = (
  request: Seen,
  { page, mainFrame, unanswered }: { page: unknown; mainFrame: unknown; unanswered: boolean },
): boolean => {
  if (request.serviceWorker() !== null || request.frame().page() !== page) {
    return false;
  }
  return !request.isNavigationRequest() || (unanswered && request.frame() === mainFrame);
};

/** A page's main document has changed: what its old one still awaited will never be answered,
 *  as an engine may cancel those requests without reporting them. */
const forgetOldDocument = (watch: Watch, page: Page): void => {
  for (const request of new Set([...watch.answering, ...watch.unfinished])) {
    const old = staleOnCommit(request, {
      page,
      mainFrame: page.mainFrame(),
      unanswered: watch.answering.has(request),
    });
    if (old) {
      watch.answering.delete(request);
      watch.unfinished.delete(request);
    }
  }
  changed(watch);
};

interface Listeners {
  readonly request: (request: Request) => void;
  readonly requestfinished: (request: Request) => void;
  readonly requestfailed: (request: Request) => void;
  readonly response: (response: Response) => void;
  readonly page: (page: Page) => void;
  readonly websocket: (socket: WebSocket) => void;
}

const describe = (watch: Watch, request: Request): string => {
  const started = watch.startedIn.get(request);
  const late =
    started !== undefined && watch.taken.has(started) ? ' (started in a reported step)' : '';
  return `${request.method()} ${new URL(request.url()).pathname}${late}`;
};

/** A request as an exchange of its step, timed by the browser's own clock where it reports one. */
const exchangeOf = (watch: Watch, request: Request, failed: boolean): Exchange => {
  const { startTime } = request.timing();
  const exchange = {
    at: startTime > 0 ? startTime : Date.now(),
    path: new URL(request.url()).pathname,
    label: `${describe(watch, request)}${failed ? ' failed' : ''}`,
    up: 0,
    down: 0,
    failed,
  };
  stepOf(watch, request).exchanges.push(exchange);
  return exchange;
};

/** Counts a finished request now, and its bytes once Playwright has its sizes. */
const finished = (watch: Watch, request: Request): void => {
  const tally = stepOf(watch, request);
  const exchange = exchangeOf(watch, request, false);
  const sized = request.sizes().then(
    (sizes) => {
      exchange.up = sizes.requestHeadersSize + sizes.requestBodySize;
      exchange.down = sizes.responseHeadersSize + sizes.responseBodySize;
    },
    // A page closed before its sizes were read: the request counts, its bytes cannot.
    (error: unknown) => {
      console.error(`traffic: no sizes for ${request.url()} (${String(error)})`);
    },
  );
  watch.pending.set(sized, tally);
  watch.unfinished.delete(request);
  answered(watch, request);
};

const listenersOf = (watch: Watch): Listeners => {
  const websocket = (socket: WebSocket): void => {
    watchSocket(watch, socket);
  };
  return {
    request: (request) => {
      if (isWeb(request)) {
        watch.answering.add(request);
        watch.unfinished.add(request);
        watch.startedIn.set(request, watch.current);
        watch.current.started += 1;
      }
    },
    requestfinished: (request) => {
      if (isWeb(request)) {
        finished(watch, request);
      }
    },
    requestfailed: (request) => {
      if (isWeb(request)) {
        exchangeOf(watch, request, true);
        watch.unfinished.delete(request);
        answered(watch, request);
      }
    },
    response: (response) => {
      answered(watch, response.request());
    },
    page: (page) => {
      page.on('websocket', websocket);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          forgetOldDocument(watch, page);
        }
      });
    },
    websocket,
  };
};

/** Listens to the context's requests and every page's sockets, until the returned stop. */
const listenOn = (context: BrowserContext, on: Listeners): (() => void) => {
  context.on('request', on.request);
  context.on('requestfinished', on.requestfinished);
  context.on('requestfailed', on.requestfailed);
  context.on('response', on.response);
  context.on('page', on.page);
  for (const page of context.pages()) {
    on.page(page);
  }
  return () => {
    context.off('request', on.request);
    context.off('requestfinished', on.requestfinished);
    context.off('requestfailed', on.requestfailed);
    context.off('response', on.response);
    context.off('page', on.page);
    for (const page of context.pages()) {
      page.off('websocket', on.websocket);
    }
  };
};

/** Watches every page of a context: each HTTP request's sizes once it finishes (a failed one
 *  counts, with no bytes), and every live socket's frames, by channel. */
export const watchTraffic = (
  context: BrowserContext,
  channels: Readonly<Record<string, RegExp>>,
): Traffic => {
  const watch: Watch = {
    channels,
    current: freshTally(channels),
    pending: new Map(),
    answering: new Set(),
    unfinished: new Set(),
    waiters: new Set(),
    startedIn: new WeakMap(),
    taken: new WeakSet(),
  };
  const stop = listenOn(context, listenersOf(watch));
  return {
    take: async () => take(watch),
    settled: async () =>
      until(
        watch,
        () => watch.answering.size === 0,
        () => `answers to ${urlsOf(watch.answering)}`,
      ),
    finished: async () =>
      until(
        watch,
        () => ownUnfinished(watch).length === 0,
        () => `bodies of ${urlsOf(ownUnfinished(watch))}`,
      ),
    started: () => watch.current.started,
    stop,
  };
};
