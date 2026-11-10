import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { Page } from '@playwright/test';
import type { AxeResults, RunOptions } from 'axe-core';

import { inPage } from './in-page.ts';
import { STILL_KIT, still } from './still.ts';

declare global {
  // Defined in the page by axe-core's own script.
  var axe: {
    readonly run: (context: Document | Element, options: RunOptions) => Promise<AxeResults>;
  };
}

/** In the page: `setTimeout` for axe-core, whose zero-delay calls run as message-channel tasks,
 *  which a paused page clock does not hold. */
const zeroDelay = (
  callback: (...args: unknown[]) => void,
  delay = 0,
  ...args: unknown[]
): unknown => {
  if (delay > 0) {
    return globalThis.setTimeout(callback, delay, ...args);
  }
  const { port1, port2 } = new globalThis.MessageChannel();
  port1.addEventListener('message', () => {
    callback(...args);
  });
  port1.start();
  port2.postMessage('task');
  return 0;
};

/** The axe-core script, which loads it into the page unless it is there: the check and the load are one script, so
 *  a screen's run and an overlay's never load it twice. */
export const AXE = `if (!('axe' in globalThis)) ((setTimeout) => {\n${readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
)}\n})(${zeroDelay.toString()});`;

/** Every axe-core rule but AAA's 7:1 contrast: text holds AA's 4.5:1, and MORE_CONTRAST's bar
 *  where more is asked for. Frames are third parties' (a video, a widget), so only titles count. */
export const STRICTEST: RunOptions = {
  runOnly: {
    type: 'tag',
    values: [
      'wcag2a',
      'wcag2aa',
      'wcag2aaa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'best-practice',
      'experimental',
    ],
  },
  rules: { 'color-contrast-enhanced': { enabled: false } },
  iframes: false,
  resultTypes: ['violations'],
};

/** The run options axe-core takes, and a check's own, which a run may give in full. */
type AxeRun = RunOptions & {
  readonly checks?: Readonly<Record<string, { readonly options: object }>>;
};

/** Text's bar where more contrast is asked for: Apple's, short of AAA's 7:1, as iOS 27's secondary
 *  label under Increase Contrast is 5.33:1 on its grouped background and 5.97:1 on white. */
export const MORE_CONTRAST_BAR = 5.3;

/** With more contrast asked for: text at MORE_CONTRAST_BAR and large text at 4.5:1, by
 *  color-contrast-enhanced; below AA, `color-contrast` reports it, so each is named once. */
export const MORE_CONTRAST: AxeRun = {
  runOnly: { type: 'rule', values: ['color-contrast', 'color-contrast-enhanced'] },
  checks: {
    'color-contrast-enhanced': {
      options: {
        ignoreUnicode: true,
        ignoreLength: false,
        ignorePseudo: false,
        boldValue: 700,
        boldTextPt: 14,
        largeTextPt: 18,
        contrastRatio: {
          normal: { expected: MORE_CONTRAST_BAR, minThreshold: 4.5 },
          large: { expected: 4.5, minThreshold: 3 },
        },
        pseudoSizeThreshold: 0.25,
        shadowOutlineEmMax: 0.1,
        textStrokeEmMin: 0.03,
      },
    },
  },
  iframes: false,
  resultTypes: ['violations'],
};

/** In the page: hears motion from now, and says whether any was heard, until then. Its end is
 *  heard too, as WebKit may not tell a start (a popover's entry) and an ended one isn't listed. */
export const motionHeard = (): (() => boolean) => {
  const { document } = globalThis;
  const types = [
    'transitionrun',
    'transitionend',
    'transitioncancel',
    'animationstart',
    'animationend',
    'animationcancel',
  ];
  const moved = { heard: false };
  const heard = (): void => {
    moved.heard = true;
  };
  for (const type of types) {
    document.addEventListener(type, heard, { capture: true });
  }
  return () => {
    for (const type of types) {
      document.removeEventListener(type, heard, { capture: true });
    }
    return moved.heard;
  };
};

/** In the page: whether a finite motion runs, as one begun since the last frame is only listed,
 *  its start event waiting for the next. */
export const motionListed = (): boolean =>
  globalThis.document.getAnimations().some(({ effect, playState }) => {
    const end = effect === null ? 0 : effect.getComputedTiming().endTime;
    return playState === 'running' && end !== Number.POSITIVE_INFINITY;
  });

/** In the page: a line per rule and element axe-core finds in `context`, once any run before has
 *  ended (it refuses two at once), read at rest: a run that motion crossed runs again. */
export const axeTurn = async (
  context: Document | Element,
  options: RunOptions,
): Promise<string[]> => {
  const key = Symbol.for('sites.testing.axe-turn');
  const before: unknown = Reflect.get(globalThis, key);
  const atRest = async (): Promise<AxeResults> => {
    await still();
    const moved = motionHeard();
    const results = await globalThis.axe.run(context, options).finally(() => {
      moved();
    });
    return moved() || motionListed() ? atRest() : results;
  };
  const run = Promise.resolve(before).then(atRest);
  Reflect.set(
    globalThis,
    key,
    run.then(
      () => 'ran',
      () => 'failed',
    ),
  );
  const { violations } = await run;
  return violations.flatMap(({ id, nodes }) =>
    nodes.map(
      ({ target, failureSummary = '' }) =>
        `${id} ${target.join(' ')}: ${failureSummary.replaceAll(/\s+/gu, ' ')}`,
    ),
  );
};

/** What axe-core finds on the page at its strictest, or under the options given. */
export const axeFindings = async (page: Page, options: AxeRun = STRICTEST): Promise<string[]> => {
  await page.evaluate(AXE);
  const kit = { motionHeard, motionListed, axeTurn };
  return inPage(page, Object.assign(kit, STILL_KIT))(
    async (given: RunOptions) => axeTurn(globalThis.document, given),
    options,
  );
};
