/* Overlays (dialogs, popovers) shown whole: readable size, opaque, heading inside and on top at
 *  its centre, and, as each opens, held to axe-core. Page-side functions name only the helpers
 *  declared in their scope, as each source is sent alone. */

import type { RunOptions } from 'axe-core';

import { axeTurn, motionHeard, motionListed } from './axe.ts';
import { STILL_KIT, still } from './still.ts';

/** In the page: the elements that label an overlay (`aria-labelledby`), drawn or not. */
const labelsOf = (overlay: Element): Element[] => {
  const ids = (overlay.getAttribute('aria-labelledby') ?? '').split(/\s+/u);
  const selector = ids
    .filter((id) => id !== '')
    .map((id) => `#${globalThis.CSS.escape(id)}`)
    .join(', ');
  return selector === '' ? [] : [...globalThis.document.querySelectorAll(selector)];
};

/** In the page: what stands for an open overlay's heading, drawn inside it: its labelling
 *  element, else its first heading, control or image. */
const headingOf = (overlay: Element): Element | undefined => {
  const candidates = overlay.querySelectorAll('h1, h2, h3, button, a[href], input, img');
  return [...labelsOf(overlay), ...candidates].find((element) => {
    const { width, height } = element.getBoundingClientRect();
    const clipped = globalThis.getComputedStyle(element).clipPath.startsWith('inset(50%');
    return overlay.contains(element) && width > 1 && height > 1 && !clipped;
  });
};

/** In the page: an overlay's visibility, its opacity through its ancestors, and its size. */
const drawnFindings = (overlay: Element, name: string): string[] => {
  const { getComputedStyle } = globalThis;
  const opacityOf = (element: Element | null): number =>
    element === null
      ? 1
      : Number(getComputedStyle(element).opacity) * opacityOf(element.parentElement);
  const rem = Number(
    getComputedStyle(globalThis.document.documentElement).fontSize.replace('px', ''),
  );
  const box = overlay.getBoundingClientRect();
  const opacity = opacityOf(overlay);
  const size = `${box.width.toFixed(1)} × ${box.height.toFixed(1)}`;
  return [
    ...(overlay.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      ? []
      : [`${name} is open yet not visible`]),
    ...(opacity < 0.999 ? [`${name} is drawn at opacity ${opacity.toFixed(2)}`] : []),
    ...(box.width < 2 * rem - 0.5 || box.height < 2 * rem - 0.5
      ? [`${name} is ${size}, under 2rem (${(2 * rem).toFixed(1)} px) each way`]
      : []),
  ];
};

/** In the page: failures under `name` unless the heading is inside the box and on top at its
 *  centre. An overlay opened over this one (a later popover or a modal) may cover it. */
const headingFindings = (overlay: Element, heading: Element, name: string): string[] => {
  const box = overlay.getBoundingClientRect();
  const head = heading.getBoundingClientRect();
  const inside =
    head.left >= box.left - 0.5 &&
    head.right <= box.right + 0.5 &&
    head.top >= box.top - 0.5 &&
    head.bottom <= box.bottom + 0.5;
  if (!inside) {
    return [
      `${name}'s heading lies outside its ${box.width.toFixed(1)} × ${box.height.toFixed(1)} box`,
    ];
  }
  const hit = globalThis.document.elementFromPoint(
    head.left + head.width / 2,
    head.top + head.height / 2,
  );
  const over = hit === null ? hit : hit.closest('dialog[open], :popover-open');
  const covered = over !== null && !over.contains(overlay);
  return hit !== null && (heading.contains(hit) || covered)
    ? []
    : [`${name}'s heading is not on top at its centre`];
};

export const shownWhole = (overlay: Element): string[] => {
  const heading = headingOf(overlay);
  const labelled = labelsOf(overlay).map((element) => element.textContent.trim());
  const text = heading === undefined ? '' : heading.textContent.trim();
  const label = overlay.getAttribute('aria-label') ?? (labelled.join(' ') || text);
  const name = `<${overlay.localName}> "${label.replaceAll(/\s+/gu, ' ').slice(0, 40)}"`;
  const placed = heading === undefined ? [] : headingFindings(overlay, heading, name);
  return [...drawnFindings(overlay, name), ...placed];
};

/** The page-side helpers `shownWhole` names, for a runner's or an init script's scope. */
export const OVERLAY_KIT = { labelsOf, headingOf, drawnFindings, headingFindings, shownWhole };

type Wait = (done: () => void, ms: number) => void;
type Frame = (callback: () => void) => void;

/** In the page: resolves once a frame is painted, by the frame and timer functions given. */
const paintedBy = async (frame: Frame, wait: Wait): Promise<void> =>
  new Promise((resolve) => {
    frame(() => {
      wait(resolve, 0);
    });
  });

/** In the page: an overlay's motion as it stands, for a finding: its opacity, its box, and each
 *  animation it runs, with its end time. */
const motionOf = (overlay: Element): string => {
  const { left, top, width, height } = overlay.getBoundingClientRect();
  const box = [left, top, width, height].map((edge) => edge.toFixed(1)).join(', ');
  const running = overlay.getAnimations().map((animation) => {
    const { effect, playState } = animation;
    const end = effect === null ? 0 : Number(effect.getComputedTiming().endTime);
    const name =
      animation instanceof globalThis.CSSTransition ? animation.transitionProperty : 'animation';
    return `${name} ${playState} at ${String(Math.round(Number(animation.currentTime)))} of ${String(end)} ms`;
  });
  return `opacity ${globalThis.getComputedStyle(overlay).opacity}, box ${box}; ${running.join(', ') || 'no animation'}`;
};

/** In the page: calls `changed` as each dialog or popover opens or closes. A popover's toggle
 *  does not bubble; a capturing listener on the document hears each one. */
const onOverlayChange = (changed: (overlay: Element, open: boolean) => void): void => {
  new globalThis.MutationObserver((records) => {
    for (const { target } of records) {
      if (target instanceof globalThis.HTMLDialogElement) {
        changed(target, target.open);
      }
    }
  }).observe(globalThis.document, { subtree: true, attributes: true, attributeFilter: ['open'] });
  const toggled = (event: Event): void => {
    const state: unknown = Reflect.get(event, 'newState');
    if (event.target instanceof globalThis.Element && typeof state === 'string') {
      changed(event.target, state === 'open');
    }
  };
  globalThis.document.addEventListener('toggle', toggled, { capture: true });
};

/** How the watch holds each opening overlay to axe-core: the page function that loads it, the
 *  one each finding is handed to, and the rules it runs. */
export interface OverlayAudit {
  readonly load: string;
  readonly report: string;
  readonly options: RunOptions;
}

export interface OverlayWatch {
  /** The page function each finding is handed to. */
  readonly binding: string;
  /** The axe-core run on each overlay as it opens; none where it would cost what is measured. */
  readonly audit?: OverlayAudit;
}

/** Where the watch keeps the holds still under way, for whoever must wait for their findings. */
const HOLDS = 'sites.testing.overlay-holds';

/** In the page: hands `finding` to the page function named `name`, where the page has it. */
const handTo = (name: string, finding: string): void => {
  const deliver: unknown = Reflect.get(globalThis, name);
  if (typeof deliver === 'function') {
    Reflect.apply(deliver, globalThis, [finding]);
  }
};

/** In the page: what axe-core finds in an overlay, loaded first where the page has none. */
const auditOf = async (overlay: Element, audit: OverlayAudit): Promise<string[]> => {
  const load: unknown = Reflect.get(globalThis, audit.load);
  if (typeof load === 'function') {
    await Reflect.apply(load, globalThis, []);
  }
  return axeTurn(overlay, audit.options);
};

/** In the page: keeps a hold among the watch's own until it ends. */
const keepHeld = (holds: Set<Promise<void>>, held: Promise<void>): void => {
  holds.add(held);
  const done = (): void => {
    holds.delete(held);
  };
  held.then(done, done);
};

/** What the watch keeps in the page: the hold each overlay is under, the page's own clock taken
 *  before the page could fake it, and where findings go. */
interface Watcher {
  readonly watch: OverlayWatch;
  readonly openings: WeakMap<Element, object>;
  readonly frame: Frame;
  readonly wait: Wait;
}

/** In the page: the overlay is still under this opening's hold. A dialog taken off the page keeps
 *  its open attribute, and no attribute change is heard. */
const heldOpen = ({ openings }: Watcher, overlay: Element, opening: object): boolean =>
  openings.get(overlay) === opening &&
  overlay.isConnected &&
  overlay.matches('dialog[open], :popover-open');

/** In the page: holds an opening overlay to `shownWhole` after a painted frame and a still page,
 *  then to axe-core. What it shows once closed or taken off the page is let go. */
const holdOpening = async (watcher: Watcher, overlay: Element, opening: object): Promise<void> => {
  const { binding, audit } = watcher.watch;
  await paintedBy(watcher.frame, watcher.wait);
  await still();
  if (!heldOpen(watcher, overlay, opening)) {
    return;
  }
  const found = shownWhole(overlay);
  const context = found.length > 0 ? [`(${motionOf(overlay)})`] : [];
  for (const finding of [...found, ...context]) {
    handTo(binding, finding);
  }
  const audited = audit === undefined ? [] : await auditOf(overlay, audit);
  for (const finding of heldOpen(watcher, overlay, opening) ? audited : []) {
    handTo(audit === undefined ? binding : audit.report, finding);
  }
};

/** In the page, from its start: each opening dialog or popover is held by `holdOpening`. The page
 *  may fake the clock. */
const watchOverlays = (watch: OverlayWatch): void => {
  const { setTimeout: timer, requestAnimationFrame: realFrame } = globalThis;
  const watcher: Watcher = {
    watch,
    openings: new WeakMap<Element, object>(),
    wait: (done, ms) => {
      Reflect.apply(timer, globalThis, [done, ms]);
    },
    frame: (callback) => {
      Reflect.apply(realFrame, globalThis, [callback]);
    },
  };
  const holds = new Set<Promise<void>>();
  Reflect.set(globalThis, Symbol.for(HOLDS), holds);
  onOverlayChange((overlay, open) => {
    if (open && !watcher.openings.has(overlay)) {
      const opening = {};
      watcher.openings.set(overlay, opening);
      const held = holdOpening(watcher, overlay, opening).catch((error: unknown) => {
        if (heldOpen(watcher, overlay, opening)) {
          handTo(watch.binding, `<${overlay.localName}> could not be held: ${String(error)}`);
        }
      });
      keepHeld(holds, held);
    } else if (!open) {
      watcher.openings.delete(overlay);
    }
  });
};

/** In the page: the page's own timer and frame, for a driver that runs under no fake clock. */
const pageWait: Wait = (done, ms) => {
  globalThis.setTimeout(done, ms);
};
const pageFrame: Frame = (callback) => {
  globalThis.requestAnimationFrame(callback);
};

/** What opening one overlay found, as `overlayOpeningScript` answers it. */
export interface Opened {
  readonly id: string;
  /** How long its entry played on the page's timeline, or 0 with no entry motion. */
  readonly entry: number;
  readonly findings: readonly string[];
}

/** In the page: opens an overlay by its trigger, holds it to `shownWhole` once its entry has
 *  played, and closes it; the entry is timed on its own timeline, which may precede the press. */
const openOne = async (trigger: HTMLElement, overlay: Element): Promise<Opened> => {
  trigger.click();
  if (!overlay.matches('dialog[open], :popover-open')) {
    return { id: overlay.id, entry: 0, findings: ['its trigger did not open it'] };
  }
  const motion = overlay.getAnimations();
  await paintedBy(pageFrame, pageWait);
  await still();
  const { timeline } = globalThis.document;
  const starts = motion.map(({ startTime }) => Number(startTime ?? timeline.currentTime));
  const entry =
    starts.length === 0 ? 0 : Math.round(Number(timeline.currentTime) - Math.min(...starts));
  const findings = shownWhole(overlay);
  if (overlay instanceof globalThis.HTMLDialogElement) {
    overlay.close();
  } else if (overlay instanceof globalThis.HTMLElement) {
    overlay.hidePopover();
  }
  await paintedBy(pageFrame, pageWait);
  return { id: overlay.id, entry, findings };
};

/** In the page: opens the overlays `queue` names one at a time, each closed before the next. */
const openFrom = async (queue: readonly (readonly [string, HTMLElement])[]): Promise<Opened[]> => {
  const [first, ...rest] = queue;
  if (first === undefined) {
    return [];
  }
  const [id, trigger] = first;
  const overlay = globalThis.document.querySelector(`#${globalThis.CSS.escape(id)}`);
  const found =
    overlay === null
      ? { id, entry: 0, findings: [`#${id} names no element`] }
      : await openOne(trigger, overlay).catch((error: unknown) => ({
          id,
          entry: 0,
          findings: [`opening it threw ${String(error)}`],
        }));
  return [found, ...(await openFrom(rest))];
};

/** In the page: opens in turn, by `openOne`, each overlay a shown trigger names (`show-modal`,
 *  popover targets), as JSON; a trigger hidden at this size, such as a phone's menu, is left. */
const openEach = async (): Promise<string> => {
  const triggers = new Map<string, HTMLElement>();
  const selector = '[command="show-modal"][commandfor], [popovertarget]';
  for (const trigger of globalThis.document.querySelectorAll<HTMLElement>(selector)) {
    const id = trigger.getAttribute('commandfor') ?? trigger.getAttribute('popovertarget') ?? '';
    if (!triggers.has(id) && trigger.checkVisibility({ visibilityProperty: true })) {
      triggers.set(id, trigger);
    }
  }
  return JSON.stringify(await openFrom([...triggers]));
};

/** In the page: resolves once every overlay the watch is holding has been judged. */
export const overlaysHeld = async (): Promise<void> => {
  const holds: unknown = Reflect.get(globalThis, Symbol.for('sites.testing.overlay-holds'));
  if (holds instanceof Set) {
    await Promise.all(holds);
  }
};

/** The page-side helpers as declarations, for an init script's or a driver's scope. */
const overlayHelpers = (): string => {
  const kit: Record<string, (...args: never[]) => unknown> = {
    auditOf,
    axeTurn,
    motionHeard,
    motionListed,
    handTo,
    heldOpen,
    holdOpening,
    keepHeld,
    motionOf,
    onOverlayChange,
    paintedBy,
    pageWait,
    pageFrame,
    openOne,
    openFrom,
  };
  const declared = Object.entries(Object.assign(kit, STILL_KIT, OVERLAY_KIT)).map(
    ([name, helper]) => `const ${name} = ${helper.toString()};`,
  );
  return [`const HOLDS = ${JSON.stringify(HOLDS)};`, ...declared].join('\n');
};

/** The init script that watches every overlay the main frame opens (`watchOverlays`). */
export const overlayWatchScript = (watch: OverlayWatch): string => {
  const options = JSON.stringify(watch);
  return [
    '(() => {',
    'if (globalThis.top !== globalThis.self) return;',
    overlayHelpers(),
    `(${watchOverlays.toString()})(${options});`,
    '})();',
  ].join('\n');
};

/** An async function body that opens each overlay the page's shown triggers name, in turn, and
 *  answers what it found as JSON (`openEach`), for a driver outside Playwright. */
export const overlayOpeningScript = (): string =>
  [overlayHelpers(), `return (${openEach.toString()})();`].join('\n');
