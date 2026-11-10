// The visitor's theme in the browser. integration.ts's bootstrap makes the same decision before
// paint, so the two must agree.
import {
  PALETTE_ATTRIBUTE,
  selectable,
  STORAGE_KEY,
  type ThemeConfig,
  type ThemeId,
} from './index.ts';

/** Storage can be refused (private mode, sandboxed frames); nothing is kept then. */
const withStorage = <Value>(task: (storage: Storage) => Value): Value | undefined => {
  try {
    return task(globalThis.localStorage);
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
    return undefined;
  }
};

/** The theme in force: the visitor's kept choice where the site offers it, else the site's own. */
export const currentTheme = (config: ThemeConfig): ThemeId => {
  const stored = config.userThemes
    ? withStorage((storage) => storage.getItem(STORAGE_KEY))
    : undefined;
  return stored !== null && stored !== undefined && selectable(config).includes(stored)
    ? stored
    : config.theme;
};

export const applyTheme = (theme: ThemeId): void => {
  const root = globalThis.document.documentElement;
  if (theme === 'default') {
    root.removeAttribute(PALETTE_ATTRIBUTE);
  } else {
    root.setAttribute(PALETTE_ATTRIBUTE, theme);
  }
};

/** Keeps the visitor's choice (where storage allows) and applies it at once. */
export const chooseTheme = (theme: ThemeId): void => {
  withStorage((storage) => {
    storage.setItem(STORAGE_KEY, theme);
  });
  applyTheme(theme);
};

/** Wires every select marked data-theme-menu, or inside such a wrapper, to the theme. */
export const bindThemeMenus = (config: ThemeConfig): void => {
  const menus = 'select[data-theme-menu], [data-theme-menu] select';
  for (const select of globalThis.document.querySelectorAll(menus)) {
    if (select instanceof globalThis.HTMLSelectElement) {
      select.value = currentTheme(config);
      select.addEventListener('change', () => {
        if (selectable(config).includes(select.value)) {
          chooseTheme(select.value);
        }
      });
    }
  }
};
