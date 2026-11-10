// Page-side font rules and helpers, run through `inPage` with design.ts's kit in scope.

export const familiesOf = (stack: string): string[] =>
  stack
    .split(',')
    .map((family) => family.replaceAll('"', '').replaceAll("'", '').trim())
    .filter((family) => family !== '');

export const firstFamily = (stack: string): string => familiesOf(stack)[0] ?? '';

/** The files a @font-face `src` loads, in order; local() sources load none. */
export const filesOf = (src: string): string[] =>
  src
    .split('url(')
    .slice(1)
    .map((part) =>
      new URL(
        part.slice(0, part.indexOf(')')).replaceAll('"', '').replaceAll("'", '').trim(),
        globalThis.document.baseURI,
      ).toString(),
    );

/** Each face loaded from a file is preloaded and displayed `optional`: drawn from the first
 *  frame or not at all on that visit, never swapped in. Cross-origin sheets are opaque. */
export const flashIn = (): string[] => {
  const { document, location } = globalThis;
  const preloaded = new Set(
    [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
      new URL(link.getAttribute('href') ?? '', document.baseURI).toString(),
    ),
  );
  const faces = Iterator.from(document.styleSheets)
    .filter(({ href }) => href === null || new URL(href).origin === location.origin)
    .flatMap(({ cssRules }) => cssRules)
    .filter((rule) => rule instanceof globalThis.CSSFontFaceRule)
    .flatMap(({ style }) =>
      filesOf(style.getPropertyValue('src'))
        .slice(0, 1)
        .map((file) => ({
          file,
          family: firstFamily(style.getPropertyValue('font-family')),
          display: style.getPropertyValue('font-display') || 'auto',
        })),
    )
    .toArray();
  return [
    ...faces
      .filter(({ display }) => display !== 'optional')
      .map(
        ({ family, display }) => `the web font "${family}" is displayed ${display}, not optional`,
      ),
    ...faces
      .filter(({ file }) => !preloaded.has(file))
      .map(({ family, file }) => `the web font "${family}" (${file}) is not preloaded`),
  ];
};
