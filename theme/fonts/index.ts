// A site names its font through siteFont: 'system', the platform's own, or an installed family,
// which no page downloads. body-font.astro brings its stylesheet.
import type { AstroIntegration } from 'astro';

import { BODY_FONT } from './variable.ts';

export { BODY_FONT } from './variable.ts';

/** Each installed family by every name a system knows it by. */
const INSTALLED = {
  // Palatino Linotype on Windows (since Windows 2000), Palatino on the Mac, iPhone and iPad.
  palatino: ['Palatino Linotype', 'Palatino'],
} as const;

/** ♩ ♪ ♫ ♬ ♭ ♮ ♯, which neither Palatino has: STIX Two Math on Apple's systems, Segoe UI Symbol on
 *  Windows, each by its full and PostScript names. The range keeps them to those signs alone. */
const MUSIC_SIGNS = {
  family: 'Music signs',
  range: 'U+2669-266F',
  names: ['STIX Two Math Regular', 'STIXTwoMath-Regular', 'Segoe UI Symbol', 'SegoeUISymbol'],
} as const;

/** An installed family, by its key. */
export type InstalledKey = keyof typeof INSTALLED;

/** What a site's text is set in: the platform's own font, or an installed family. */
export type FontChoice = 'system' | InstalledKey;

/** Whether a config's choice, which a JavaScript config may misspell, is one of them. */
export const isFontChoice = (choice: string): choice is FontChoice =>
  choice === 'system' || Object.hasOwn(INSTALLED, choice);

/** An installed family's stack: its names, the music signs, then the platform's own font
 *  (Tailwind's --font-sans), which a system without the family sets the text in. */
export const installedStack = (key: InstalledKey): string =>
  `${[...INSTALLED[key], MUSIC_SIGNS.family].map((name) => `'${name}'`).join(', ')}, var(--font-sans)`;

const stylesheetOf = (key: InstalledKey): string => {
  const sources = MUSIC_SIGNS.names.map((name) => `local('${name}')`).join(', ');
  return [
    `@font-face { font-family: '${MUSIC_SIGNS.family}'; src: ${sources}; unicode-range: ${MUSIC_SIGNS.range}; }`,
    `:root { ${BODY_FONT}: ${installedStack(key)}; }`,
    '',
  ].join('\n');
};

/** What body-font.astro imports: the chosen family's stylesheet, or nothing for the system font. */
export const MODULE = 'virtual:@tonalisk-labs/kit/fonts/body';
const STYLESHEET = 'virtual:@tonalisk-labs/kit/fonts/body.css';

const modulesOf = (choice: FontChoice): ReadonlyMap<string, string> =>
  choice === 'system'
    ? new Map([[MODULE, '']])
    : new Map([
        [MODULE, `import '${STYLESHEET}';`],
        [STYLESHEET, stylesheetOf(choice)],
      ]);

const TYPES = `declare module '${MODULE}' {}\n`;

/** Serves the chosen family's stylesheet to body-font.astro; 'system' serves an empty module. */
export const siteFont = (choice: FontChoice): AstroIntegration => ({
  name: '@tonalisk-labs/kit/fonts',
  hooks: {
    'astro:config:setup': ({ updateConfig }) => {
      if (!isFontChoice(choice)) {
        throw new Error(
          `@tonalisk-labs/kit/fonts: no font "${String(choice)}" (system, or an installed one)`,
        );
      }
      const modules = modulesOf(choice);
      updateConfig({
        vite: {
          plugins: [
            {
              name: '@tonalisk-labs/kit/fonts',
              resolveId: (id: string): string | undefined =>
                modules.has(id) ? `\0${id}` : undefined,
              load: (id: string): string | undefined =>
                id.startsWith('\0') ? modules.get(id.slice(1)) : undefined,
            },
          ],
        },
      });
    },
    'astro:config:done': ({ injectTypes }) => {
      injectTypes({ filename: 'sites-fonts.d.ts', content: TYPES });
    },
  },
});
