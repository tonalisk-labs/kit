/* Keyboard-only tests. A test that sets `keyboardOnly` fails on any press of a pointer, touch or
 *  turn of a wheel its page hears, so whatever it reaches, it reaches by keys alone; and
 *  `focusReturns` holds a dialog or menu to WCAG 2.4.3's focus order: focus goes into it as it
 *  opens, and comes back to the control that opened it as it closes. */
import { expect, type Locator, type Page } from '@playwright/test';

/** What a keyboard-only page hears that a keyboard never makes. */
const POINTER_EVENTS = ['pointerdown', 'touchstart', 'wheel'] as const;

/** In the page, from its start: each pointer press, touch or wheel turn a person made (a script's
 *  own events are not), named to `binding`. */
const watchPointer = ({ binding, types }: { binding: string; types: readonly string[] }): void => {
  const heard = (event: Event): void => {
    const deliver: unknown = Reflect.get(globalThis, binding);
    if (!event.isTrusted || typeof deliver !== 'function') {
      return;
    }
    const { target } = event;
    const where = target instanceof globalThis.Element ? `<${target.localName}>` : 'the page';
    Reflect.apply(deliver, globalThis, [`${event.type} on ${where}`]);
  };
  for (const type of types) {
    globalThis.addEventListener(type, heard, { capture: true, passive: true });
  }
};

/** The init script that names each pointer press a page hears to `binding`. */
export const pointerWatchScript = (binding: string): string =>
  `(${watchPointer.toString()})(${JSON.stringify({ binding, types: POINTER_EVENTS })});`;

export interface Opening {
  /** Opens the overlay from the control that has focus, by keys in a keyboard-only test. */
  readonly open: () => Promise<unknown>;
  /** The dialog, menu or popover `open` shows. */
  readonly overlay: Locator;
  /** Closes it, as a person does: Escape, or the control that closes it. */
  readonly close: () => Promise<unknown>;
}

/** What has focus, as assistive technology names it: its role, name and state. */
const focusedOf = async (page: Page): Promise<string> => {
  const focused = page.locator(':focus');
  return (await focused.count()) === 1 ? focused.ariaSnapshot() : '';
};

const CLOSED = 'sites.testing.overlay-closed';

/** Arms a wait for the overlay's close, as a dialog's `close` or a popover's `toggle` tells: added
 *  last, it runs after the page's own handlers, so focus they move has moved. */
const closeHeard = async (overlay: Locator): Promise<() => Promise<void>> => {
  await overlay.evaluate((element, key) => {
    const dialog = element.tagName === 'DIALOG';
    if (!dialog && !element.hasAttribute('popover')) {
      throw new Error('focusReturns holds a dialog or a popover, which say when they have closed');
    }
    const closed = new Promise((resolve) => {
      element.addEventListener(dialog ? 'close' : 'toggle', resolve, { once: true });
    });
    Reflect.set(element, Symbol.for(key), closed);
  }, CLOSED);
  return async () => {
    await overlay.evaluate(async (element, key) => {
      const closed: unknown = Reflect.get(element, Symbol.for(key));
      await closed;
    }, CLOSED);
  };
};

/** Opens an overlay from the control that has focus, holds focus to have moved inside it, closes
 *  it, and holds focus to have come back to that control (WCAG 2.4.3). */
export const focusReturns = async (
  page: Page,
  { open, overlay, close }: Opening,
): Promise<void> => {
  const opener = await focusedOf(page);
  expect(opener, 'a control has focus before the overlay opens').not.toBe('');
  await open();
  await expect(overlay).toBeVisible();
  await expect
    .poll(
      async () =>
        overlay.evaluate((element) => element.contains(globalThis.document.activeElement)),
      { message: 'focus moves into the overlay as it opens' },
    )
    .toBe(true);
  const closed = await closeHeard(overlay);
  await close();
  await closed();
  expect(
    await focusedOf(page),
    'focus comes back to the control that opened the overlay as it closes',
  ).toBe(opener);
};
