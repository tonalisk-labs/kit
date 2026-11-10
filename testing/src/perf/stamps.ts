/** A DOM change: when, its target, its kind and the nodes it added, held weakly, so a node the
 *  page lets go is no step's outcome, nor kept alive to count in the page's heap. */
type Change = readonly [number, WeakRef<Node>, MutationRecordType, readonly WeakRef<Node>[]];

export interface StampOptions {
  readonly key: string;
}

export interface Seen {
  /** Whether the step left the document it began on: then it is timed from the new one's start. */
  navigated: boolean;
  from: number;
  /** When the outcome could first be painted: the frame after the last change that made it. */
  visibleAt: number;
  /** Frames that ran long where the engine has no long-animation-frame entries, as [start, gap]. */
  gaps: (readonly [number, number])[];
}

/** Stamps the frame after each DOM change, kept from the document's start (a step may navigate to
 *  it) and from each step's start to its end, which takes them by page event. */
export const collectStamps = ({ key }: StampOptions): void => {
  const changes: Change[] = [];
  const painted = new Map<number, number>();
  const state = { begun: false, kept: true };
  new globalThis.MutationObserver((records) => {
    if (!state.kept) {
      return;
    }
    const time = performance.now();
    for (const record of records) {
      const added = [...record.addedNodes].map((node) => new WeakRef(node));
      changes.push([time, new WeakRef(record.target), record.type, added]);
    }
    globalThis.requestAnimationFrame((frame) => {
      painted.set(time, frame);
    });
  }).observe(globalThis.document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  globalThis.addEventListener(`${key}:begin`, () => {
    changes.length = 0;
    painted.clear();
    Object.assign(state, { begun: true, kept: true });
  });
  globalThis.addEventListener(`${key}:end`, (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail === 'object' && detail !== null) {
      const taken = { changes: changes.splice(0), painted: new Map(painted), begun: state.begun };
      Object.assign(detail, taken);
    }
    painted.clear();
    state.kept = false;
  });
};

/** Without LoAF (Firefox, WebKit): a frame loop records each step's gaps over 50 ms, the
 *  long-task threshold. */
export const collectGaps = ({ key }: StampOptions): void => {
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
    return;
  }
  const gaps: [number, number][] = [];
  const last = { frame: performance.now() };
  const tick = (frame: number): void => {
    if (frame - last.frame > 50) {
      gaps.push([last.frame, frame - last.frame]);
    }
    last.frame = frame;
    globalThis.requestAnimationFrame(tick);
  };
  globalThis.requestAnimationFrame(tick);
  globalThis.addEventListener(`${key}:begin`, () => {
    gaps.length = 0;
  });
  globalThis.addEventListener(`${key}:end`, (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail === 'object' && detail !== null) {
      Reflect.set(detail, 'gaps', [...gaps]);
    }
  });
};

/** In the page: starts a step's stamps afresh, and answers its start on the page's clock. */
export const beginStamps = (key: string): number => {
  globalThis.dispatchEvent(new CustomEvent(`${key}:begin`));
  return performance.now();
};

/** In the page: when the outcome, `element`, could first be painted (after the last change within
 *  it, else to its attributes), and its long frames. A node let go reads as an empty Text. */
export const endStamps = ([element, key, since]: readonly [Node, string, number]): Seen => {
  const detail = {
    element,
    since,
    changes: [] as readonly Change[],
    painted: new Map<number, number>(),
    begun: false,
    gaps: [] as Seen['gaps'],
  };
  globalThis.dispatchEvent(new CustomEvent(`${key}:end`, { detail }));
  const now = performance.now();
  const from = detail.begun ? since : 0;
  const none = new globalThis.Text();
  const inside = ([, target, , added]: Change): boolean =>
    element.contains(target.deref() ?? none) ||
    added.some((ref) => (ref.deref() ?? none).contains(element));
  const latest = (changes: readonly Change[]): number => {
    let last = from;
    for (const [time] of changes) {
      last = Math.max(last, time);
    }
    return last;
  };
  const kept = detail.changes.filter(([time]) => time <= now);
  const content = kept.filter((change) => change[2] !== 'attributes' && inside(change));
  const own = kept.filter(
    ([, target, type]) => type === 'attributes' && target.deref() === element,
  );
  const at = content.length > 0 ? latest(content) : latest(own);
  const visibleAt = detail.painted.get(at) ?? at;
  return { navigated: !detail.begun, from, visibleAt, gaps: detail.gaps };
};
