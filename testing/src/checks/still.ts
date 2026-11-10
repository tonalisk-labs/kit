import type { Page } from '@playwright/test';

import { inPage } from './in-page.ts';

/** The end events a wait listens for, and which of them it waits for. */
interface Ends {
  types: readonly string[];
  accepts: (event: Event) => boolean;
}

/** In the page: the first event at `target` that `ends` accepts, heard until `signal` aborts. */
const endHeard = async (
  target: EventTarget,
  { types, accepts }: Ends,
  signal: AbortSignal,
): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<Event>();
  const heard = (event: Event): void => {
    if (accepts(event)) {
      resolve(event);
    }
  };
  for (const type of types) {
    target.addEventListener(type, heard, { capture: true, signal });
  }
  await promise;
};

/** In the page: once the event being sent has reached every listener, the page's own included: a
 *  task posted now runs after the dispatch, and its channel is one no page clock holds. */
const dispatched = async (): Promise<void> => {
  const { port1, port2 } = new globalThis.MessageChannel();
  const { promise, resolve } = Promise.withResolvers<MessageEvent>();
  port1.addEventListener('message', resolve);
  port1.start();
  port2.postMessage('sent');
  await promise;
  port1.close();
};

/** In the page: a CSS motion's pseudo-element and name, as its end events carry them; none for a
 *  script's animation. */
const motionKey = (animation: Animation): string | undefined => {
  const { effect } = animation;
  const pseudo = effect instanceof globalThis.KeyframeEffect ? (effect.pseudoElement ?? '') : '';
  if (animation instanceof globalThis.CSSTransition) {
    return `${pseudo} ${animation.transitionProperty}`;
  }
  if (animation instanceof globalThis.CSSAnimation) {
    return `${pseudo} ${animation.animationName}`;
  }
  return undefined;
};

/** In the page: the pseudo-element and name an end event carries, as `motionKey` reads them. */
const endKey = (event: Event): string | undefined => {
  if (event instanceof globalThis.TransitionEvent) {
    return `${event.pseudoElement} ${event.propertyName}`;
  }
  if (event instanceof globalThis.AnimationEvent) {
    return `${event.pseudoElement} ${event.animationName}`;
  }
  return undefined;
};

/** In the page: a CSS motion's own end event at its element, sent to every listener, which its
 *  engine does after the motion's promise; at once for a script's animation, which it ends. */
const ownEnd = async (animation: Animation, signal: AbortSignal): Promise<void> => {
  const { effect } = animation;
  const key = motionKey(animation);
  if (
    !(effect instanceof globalThis.KeyframeEffect) ||
    effect.target === null ||
    key === undefined
  ) {
    return;
  }
  const { target } = effect;
  const types =
    animation instanceof globalThis.CSSTransition
      ? ['transitionend', 'transitioncancel']
      : ['animationend', 'animationcancel'];
  const accepts = (event: Event): boolean => event.target === target && endKey(event) === key;
  await endHeard(target, { types, accepts }, signal);
  await dispatched();
};

/** In the page: once `animation` has ended, its end event sent as well. A cancelled one rejects
 *  its promise, and has ended whether its engine tells it or not. */
const motionEnded = async (animation: Animation): Promise<void> => {
  const listening = new AbortController();
  const told = ownEnd(animation, listening.signal);
  try {
    const finished = await animation.finished.then(
      () => true,
      (error: unknown) => {
        if (error instanceof globalThis.DOMException && error.name === 'AbortError') {
          return false;
        }
        throw error;
      },
    );
    if (finished) {
      await told;
    }
  } finally {
    listening.abort();
  }
};

/** In the page: the engine's next update of its finished motions, which their first end event
 *  tells. */
const updateHeard = async (): Promise<void> => {
  const listening = new AbortController();
  const types = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
  await endHeard(globalThis.document, { types, accepts: () => true }, listening.signal);
  listening.abort();
};

/** In the page: what `animation` is still to do before the page is at rest, if anything. */
const motionWait = (animation: Animation): Promise<void>[] => {
  const timing = animation.effect === null ? undefined : animation.effect.getComputedTiming();
  const end = timing === undefined ? 0 : timing.endTime;
  if (animation.playState === 'running' && end !== Number.POSITIVE_INFINITY) {
    return [motionEnded(animation)];
  }
  // A finished CSS transition, or animation filling no forwards, still listed is unapplied.
  const filled = timing !== undefined && ['forwards', 'both'].includes(String(timing.fill));
  const css =
    animation instanceof globalThis.CSSTransition ||
    (animation instanceof globalThis.CSSAnimation && !filled);
  return animation.playState === 'finished' && css ? [updateHeard()] : [];
};

/** In the page: once every finite motion has ended and been applied, again until none began
 *  meanwhile. */
const motionsEnded = async (): Promise<void> => {
  const waits = globalThis.document.getAnimations().flatMap((animation) => motionWait(animation));
  if (waits.length > 0) {
    await Promise.all(waits);
    await motionsEnded();
  }
};

/** In the page: fonts loaded and every ending motion ended and applied. Awaits promises and events
 *  alone, as a page clock may hold frames and timers. */
export const still = async (): Promise<void> => {
  await globalThis.document.fonts.ready;
  await motionsEnded();
};

/** The page-side helpers `still` names, for each page script that runs it. */
export const STILL_KIT = {
  endHeard,
  dispatched,
  motionKey,
  endKey,
  ownEnd,
  motionEnded,
  updateHeard,
  motionWait,
  motionsEnded,
  still,
};

/** Returns once the page is still, as `still` tells. */
export const untilStill = async (page: Page): Promise<void> => {
  await inPage(page, STILL_KIT)(still);
};

/** In the page: turns every transition off, or back on, while colours are read. A constructed
 *  sheet, as the page's CSP refuses an inline one. */
export const holdStill = (on: boolean): void => {
  const { document } = globalThis;
  const key = Symbol.for('sites.testing.hold-still');
  const held: unknown = Reflect.get(globalThis, key);
  const sheet = held instanceof globalThis.CSSStyleSheet ? held : new globalThis.CSSStyleSheet();
  if (!(held instanceof globalThis.CSSStyleSheet)) {
    sheet.replaceSync('*, *::before, *::after { transition: none !important; }');
    Reflect.set(globalThis, key, sheet);
  }
  const others = document.adoptedStyleSheets.filter((one) => one !== sheet);
  document.adoptedStyleSheets = on ? [...others, sheet] : others;
};
