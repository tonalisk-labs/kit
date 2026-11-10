import type { Exchange } from './traffic.ts';

/** A fetch the page started while a socket was reconnecting: its path, and when (epoch ms). */
type Call = readonly [string, number];

export interface SocketOptions {
  readonly key: string;
}

/** What the socket collector shares with the page's later reads, under `key`. */
interface Sockets {
  readonly key: string;
  readonly down: Set<string>;
  readonly opened: Set<string>;
  readonly connecting: { count: number };
}

/** In the page: a socket counts as connecting until it closes or its opening has had a frame,
 *  and one closed other than by choice (1000, or 1001 on leaving) is down till its path reopens. */
const watchSocket = (socket: WebSocket, { key, down, opened, connecting }: Sockets): void => {
  const { pathname } = new URL(socket.url);
  const state = { connecting: true };
  connecting.count += 1;
  const connected = (): void => {
    if (state.connecting) {
      state.connecting = false;
      connecting.count -= 1;
      globalThis.dispatchEvent(new CustomEvent(`${key}:connected`));
    }
  };
  socket.addEventListener('close', (event) => {
    if (event.code !== 1000 && event.code !== 1001) {
      down.add(pathname);
    }
    connected();
  });
  const reopened = (): void => {
    down.delete(pathname);
    opened.add(pathname);
    connected();
  };
  socket.addEventListener('open', () => {
    globalThis.requestAnimationFrame(() => {
      const { port1, port2 } = new globalThis.MessageChannel();
      port1.addEventListener('message', reopened);
      port1.start();
      port2.postMessage('frame');
    });
  });
};

/** The helper `collectSockets` runs with, through `pageScript`. */
export const SOCKET_KIT = { watchSocket };

/** In the page, before its scripts: every socket is followed by `watchSocket`, connecting, down or
 *  reopened, under `key`'s symbols. */
export const collectSockets = ({ key }: SocketOptions): void => {
  const sockets: Sockets = {
    key,
    down: new Set<string>(),
    opened: new Set<string>(),
    connecting: { count: 0 },
  };
  Object.defineProperty(globalThis, Symbol.for(`${key}:down`), { value: sockets.down });
  Object.defineProperty(globalThis, Symbol.for(`${key}:connecting`), { value: sockets.connecting });
  Object.defineProperty(globalThis, Symbol.for(`${key}:opened`), { value: sockets.opened });
  const Native = globalThis.WebSocket;
  class Logged extends Native {
    public constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      watchSocket(this, sockets);
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: Logged, writable: true });
};

/** Runs in the page after `collectSockets`: logs every fetch started while a socket is down. */
export const collectReconnectCalls = ({ key }: SocketOptions): void => {
  const calls: Call[] = [];
  Object.defineProperty(globalThis, Symbol.for(key), { value: calls });
  const down: unknown = Reflect.get(globalThis, Symbol.for(`${key}:down`));
  const nativeFetch = globalThis.fetch;
  const logged = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (down instanceof Set && down.size > 0) {
      const url = input instanceof Request ? input.url : String(input);
      const at = performance.timeOrigin + performance.now();
      calls.push([new URL(url, globalThis.location.href).pathname, at]);
    }
    return nativeFetch(input, init);
  };
  Object.defineProperty(globalThis, 'fetch', { value: logged, writable: true });
};

/** In the page: resolves once no socket is connecting, its opening's catch-up included. */
export const socketsConnected = async (key: string): Promise<void> =>
  new Promise((resolve) => {
    const found: unknown = Reflect.get(globalThis, Symbol.for(`${key}:connecting`));
    const count = (): unknown =>
      typeof found === 'object' && found !== null ? Reflect.get(found, 'count') : 0;
    if (count() === 0) {
      resolve();
      return;
    }
    const check = (): void => {
      if (count() === 0) {
        globalThis.removeEventListener(`${key}:connected`, check);
        resolve();
      }
    };
    globalThis.addEventListener(`${key}:connected`, check);
  });

/** In the page: resolves once a socket on a path matching `source` has opened in this document,
 *  its catch-up started. */
export const socketOpened = async ([key, source]: readonly [string, string]): Promise<void> =>
  new Promise((resolve) => {
    const found: unknown = Reflect.get(globalThis, Symbol.for(`${key}:opened`));
    const pattern = new RegExp(source, 'u');
    const open = (): boolean =>
      found instanceof Set && [...found].some((path) => pattern.test(String(path)));
    if (open()) {
      resolve();
      return;
    }
    const check = (): void => {
      if (open()) {
        globalThis.removeEventListener(`${key}:connected`, check);
        resolve();
      }
    };
    globalThis.addEventListener(`${key}:connected`, check);
  });

/** Runs in the page. */
export const noneConnecting = (key: string): boolean => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(`${key}:connecting`));
  return typeof found !== 'object' || found === null || Reflect.get(found, 'count') === 0;
};

/** Runs in the page. */
export const reconnectCalls = (key: string): Call[] => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(key));
  const log: readonly unknown[] = Array.isArray(found) ? found : [];
  return log.filter(
    (call): call is Call =>
      Array.isArray(call) && typeof call[0] === 'string' && typeof call[1] === 'number',
  );
};

/** A step's own requests, and those made reconnecting a dropped socket. */
export interface Split {
  readonly own: readonly Exchange[];
  readonly reconnecting: readonly Exchange[];
}

/** How far a request's network start may lead the page's call on the clock, from rounding. */
const CALL_SKEW_MS = 1;

/** Splits a step's requests: each fetch a reconnect started on its own paths claims the next
 *  request started on that path; any other request (a save made meanwhile) stays the step's. */
export const splitReconnects = (
  exchanges: readonly Exchange[],
  { calls, paths }: { readonly calls: readonly Call[]; readonly paths: RegExp | undefined },
): Split => {
  const claimed = new Set<Exchange>();
  const ordered = exchanges.toSorted((one, other) => one.at - other.at);
  const reconnecting = paths === undefined ? [] : calls.filter(([path]) => paths.test(path));
  for (const [path, at] of reconnecting.toSorted(([, one], [, other]) => one - other)) {
    const match = ordered.find(
      (exchange) =>
        !claimed.has(exchange) && exchange.path === path && exchange.at >= at - CALL_SKEW_MS,
    );
    if (match !== undefined) {
      claimed.add(match);
    }
  }
  return {
    own: exchanges.filter((exchange) => !claimed.has(exchange)),
    reconnecting: exchanges.filter((exchange) => claimed.has(exchange)),
  };
};
