// The Astro integration each site configures with its theme: it loads the theme stylesheets, sets
// data-palette and the `dark` class before first paint, and serves `virtual:@tonalisk-labs/kit/themes`.
import type { AstroIntegration } from 'astro';

import {
  isThemeId,
  PALETTE_ATTRIBUTE,
  selectable,
  STORAGE_KEY,
  type ThemeConfig,
  USER_THEMES,
} from './index.ts';

const VIRTUAL = 'virtual:@tonalisk-labs/kit/themes';
const RESOLVED = `\0${VIRTUAL}`;

/** The choice kept in the browser wins over the configured theme when visitors may choose. */
const bootstrap = ({ theme, userThemes }: ThemeConfig): string => {
  const configured = JSON.stringify(theme);
  if (!userThemes) {
    return `document.documentElement.setAttribute('${PALETTE_ATTRIBUTE}', ${configured});`;
  }
  const allowed = JSON.stringify(selectable({ theme, userThemes }));
  return `(() => {
  let stored = null;
  try { stored = localStorage.getItem('${STORAGE_KEY}'); } catch (error) { if (!(error instanceof DOMException)) throw error; }
  const theme = ${allowed}.includes(stored) ? stored : ${configured};
  if (theme !== 'default') document.documentElement.setAttribute('${PALETTE_ATTRIBUTE}', theme);
})();`;
};

/** The light/dark choice kept under `key`, else the system's, as the `dark` class; with no
 *  choice kept, it follows the system as that changes, on every page. */
const modeBootstrap = (key: string): string => `(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    let stored = null;
    try { stored = localStorage.getItem(${JSON.stringify(key)}); } catch (error) { if (!(error instanceof DOMException)) throw error; }
    const dark = stored === 'dark' || (stored !== 'light' && system.matches);
    document.documentElement.classList.toggle('dark', dark);
  };
  apply();
  system.addEventListener('change', apply);
})();`;

/** Leaves out default.css, which re-points a region of a themed page back to Tailwind's scales:
 *  a site that draws a default swatch imports it. */
const stylesheets = (config: ThemeConfig): readonly string[] =>
  selectable(config).filter((id) => id !== 'default');

const TYPES = `declare module '${VIRTUAL}' {
  export const themeConfig: import('@tonalisk-labs/kit/theme').ThemeConfig;
}
`;

export const sitesTheme = (config: ThemeConfig): AstroIntegration => ({
  name: 'sites-theme',
  hooks: {
    'astro:config:setup': ({ injectScript, updateConfig }) => {
      const unknown = [config.theme, ...USER_THEMES].find((id) => !isThemeId(id));
      if (unknown !== undefined) {
        throw new Error(`sitesTheme: no theme "${unknown}" in themes.json`);
      }
      for (const id of stylesheets(config)) {
        injectScript('page-ssr', `import '@tonalisk-labs/kit/themes/${id}.css';`);
      }
      if (config.userThemes || config.theme !== 'default') {
        injectScript('head-inline', bootstrap(config));
      }
      if (config.modeKey !== undefined) {
        injectScript('head-inline', modeBootstrap(config.modeKey));
      }
      const module = `export const themeConfig = ${JSON.stringify(config)};`;
      updateConfig({
        vite: {
          plugins: [
            {
              name: 'sites-theme',
              resolveId: (id: string): string | undefined =>
                id === VIRTUAL ? RESOLVED : undefined,
              load: (id: string): string | undefined => (id === RESOLVED ? module : undefined),
            },
          ],
        },
      });
    },
    'astro:config:done': ({ injectTypes }) => {
      injectTypes({ filename: 'sites-theme.d.ts', content: TYPES });
    },
  },
});
