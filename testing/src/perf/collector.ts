export interface Resource {
  readonly url: string;
  /** Whether it is the target's own API, under its prefix. */
  readonly api: boolean;
  readonly initiator: string;
  readonly protocol: string;
  readonly start: number;
  readonly end: number;
  /** Request sent to first byte: the network round trip plus the server's time. */
  readonly waiting: number;
  /** Bytes as they crossed the network (0 from a cache), and the body encoded and decoded. */
  readonly transfer: number;
  readonly encoded: number;
  readonly decoded: number;
  readonly serverTiming: readonly { readonly name: string; readonly duration: number }[];
}

/** A node a layout shift moved, by selector, with its rects before and after as [x, y, w, h]. */
type Moved = readonly [string, readonly number[], readonly number[]];

/** A layout shift not caused by input, as [time, value, moved nodes]. */
export type Shift = readonly [number, number, readonly Moved[]];

/** What a document measured of itself, in milliseconds but for CLS. */
export interface Store {
  /** Which document measured: a navigation between two reads changes it. */
  document: string;
  /** The document's own response start, from its navigation entry. */
  ttfb: number;
  fcp: number;
  lcp: number;
  cls: number;
  /** The current CLS session window: its total, first and last shift times. */
  session: [number, number, number];
  /** Event Timing entries at or over 16 ms, as [interactionId, duration]. */
  events: [number, number][];
  /** Long animation frames, as [duration, blocking duration, start]. */
  frames: [number, number, number][];
  resources: Resource[];
  /** Set by `collectShifts`, where it runs. */
  shifts?: Shift[];
}

export interface CollectorOptions {
  readonly key: string;
  readonly apiPrefix: string;
}

type Handlers = Record<string, (entry: PerformanceEntry) => void>;

/** Event Timing's own option: the shortest event it reports. */
type ObserverInit = PerformanceObserverInit & { durationThreshold?: number };

/** In the page: hands on each buffered entry of every type `handlers` names, where the engine
 *  has it, observed as `own` sets out for its type, if at all. */
const observeAll = (handlers: Handlers, own: Readonly<Record<string, ObserverInit>> = {}): void => {
  for (const [type, onEntry] of Object.entries(handlers)) {
    if (PerformanceObserver.supportedEntryTypes.includes(type)) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          onEntry(entry);
        }
      }).observe(own[type] ?? { type, buffered: true });
    }
  }
};

/** In the page: a layout shift added to CLS's session window, and the score its largest. A shift
 *  within half a second of input is the person's doing, so CLS leaves it out of both. */
const takeShift = (store: Store, entry: PerformanceEntry): void => {
  if (Reflect.get(entry, 'hadRecentInput') === true) {
    return;
  }
  const [total, first, last] = store.session;
  const shift: unknown = Reflect.get(entry, 'value');
  const value = typeof shift === 'number' ? shift : 0;
  const joins = entry.startTime - last < 1000 && entry.startTime - first < 5000;
  store.session = joins
    ? [total + value, first, entry.startTime]
    : [value, entry.startTime, entry.startTime];
  store.cls = Math.max(store.cls, store.session[0]);
};

/** The helpers the collectors run through `pageScript` name. */
export const COLLECTOR_KIT = { observeAll, takeShift };

/** TTFB, FCP, LCP, and CLS as its largest session window (gaps < 1 s, span < 5 s). Collectors name
 *  only COLLECTOR_KIT and read only observers, as Playwright's fake clock stubs `performance`. */
export const collectPaint = ({ key }: CollectorOptions): void => {
  const store: Store = {
    document: globalThis.crypto.getRandomValues(new Uint32Array(4)).join('.'),
    ttfb: -1,
    fcp: -1,
    lcp: -1,
    cls: 0,
    session: [0, 0, 0],
    events: [],
    frames: [],
    resources: [],
  };
  Object.defineProperty(globalThis, Symbol.for(key), { value: store });
  observeAll({
    navigation: (entry) => {
      const start: unknown = Reflect.get(entry, 'responseStart');
      store.ttfb = typeof start === 'number' ? start : store.ttfb;
    },
    paint: (entry) => {
      store.fcp = entry.name === 'first-contentful-paint' ? entry.startTime : store.fcp;
    },
    'largest-contentful-paint': (entry) => {
      store.lcp = entry.startTime;
    },
    'layout-shift': (entry) => {
      takeShift(store, entry);
    },
  });
};

/** Each shift's moved nodes, named by tag, id and first three classes, a text node by its
 *  parent. */
export const collectShifts = ({ key }: CollectorOptions): void => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(key));
  const shifts: Shift[] = [];
  const observed = PerformanceObserver.supportedEntryTypes.includes('layout-shift');
  if (typeof found !== 'object' || found === null || !observed) {
    return;
  }
  Reflect.set(found, 'shifts', shifts);
  const { DOMRectReadOnly: Rect, Element: Tagged, Text: Words } = globalThis;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const sources: unknown = Reflect.get(entry, 'sources');
      const value: unknown = Reflect.get(entry, 'value');
      const moved = (Array.isArray(sources) ? sources : []).map((source: unknown): Moved => {
        const at = (name: string): unknown =>
          typeof source === 'object' && source !== null ? Reflect.get(source, name) : undefined;
        const node = at('node');
        const element = node instanceof Words ? node.parentElement : node;
        const id = element instanceof Tagged && element.id !== '' ? `#${element.id}` : '';
        const classes = element instanceof Tagged ? [...element.classList].slice(0, 3) : [];
        const name = element instanceof Tagged ? element.localName : '(removed)';
        const [before, after] = [at('previousRect'), at('currentRect')].map((rect) =>
          rect instanceof Rect
            ? [rect.x, rect.y, rect.width, rect.height].map((px) => Math.round(px))
            : [],
        );
        return [
          `${name}${id}${classes.map((token) => `.${token}`).join('')}`,
          before ?? [],
          after ?? [],
        ];
      });
      if (Reflect.get(entry, 'hadRecentInput') !== true && typeof value === 'number') {
        shifts.push([entry.startTime, value, moved]);
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

/** Interactions (Event Timing) and long animation frames. */
export const collectActivity = ({ key }: CollectorOptions): void => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(key));
  const [events, frames] = ['events', 'frames'].map((name): unknown =>
    typeof found === 'object' && found !== null ? Reflect.get(found, name) : undefined,
  );
  const interaction = (entry: PerformanceEntry): void => {
    const id: unknown = Reflect.get(entry, 'interactionId');
    if (typeof id === 'number' && id > 0 && Array.isArray(events)) {
      events.push([id, entry.duration]);
    }
  };
  const handlers: Handlers = {
    event: interaction,
    'first-input': interaction,
    'long-animation-frame': (entry) => {
      const blocking: unknown = Reflect.get(entry, 'blockingDuration');
      if (Array.isArray(frames)) {
        const blocked = typeof blocking === 'number' ? blocking : 0;
        frames.push([entry.duration, blocked, entry.startTime]);
      }
    },
  };
  observeAll(handlers, { event: { type: 'event', buffered: true, durationThreshold: 16 } });
};

export const collectResources = ({ key, apiPrefix }: CollectorOptions): void => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(key));
  const resources: unknown =
    typeof found === 'object' && found !== null ? Reflect.get(found, 'resources') : undefined;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry instanceof PerformanceResourceTiming && Array.isArray(resources)) {
        const { pathname } = new URL(entry.name);
        resources.push({
          url: entry.name,
          api: apiPrefix !== '' && pathname.startsWith(`${apiPrefix}/`),
          initiator: entry.initiatorType,
          protocol: entry.nextHopProtocol,
          start: entry.startTime,
          end: entry.responseEnd,
          waiting: entry.responseStart - entry.requestStart,
          transfer: entry.transferSize,
          encoded: entry.encodedBodySize,
          decoded: entry.decodedBodySize,
          serverTiming: entry.serverTiming.map(({ name, duration }) => ({ name, duration })),
        });
      }
    }
  }).observe({ type: 'resource', buffered: true });
};

export interface Drained {
  /** Unchecked here: the reader validates it. */
  readonly store: unknown;
  readonly interactionCount: number | undefined;
}

/** Reads the document's store and empties its lists and its CLS windows, so the next read
 *  covers the next step alone. */
export const drain = (key: string): Drained => {
  const found: unknown = Reflect.get(globalThis, Symbol.for(key));
  const counted: unknown = Reflect.get(performance, 'interactionCount');
  const result = { interactionCount: typeof counted === 'number' ? counted : undefined };
  const store: unknown = structuredClone(found);
  if (typeof found !== 'object' || found === null) {
    return Object.assign(result, { store });
  }
  for (const list of [
    Reflect.get(found, 'events'),
    Reflect.get(found, 'frames'),
    Reflect.get(found, 'resources'),
    Reflect.get(found, 'shifts'),
  ]) {
    if (Array.isArray(list)) {
      list.length = 0;
    }
  }
  Reflect.set(found, 'cls', 0);
  Reflect.set(found, 'session', [0, 0, 0]);
  return Object.assign(result, { store });
};
