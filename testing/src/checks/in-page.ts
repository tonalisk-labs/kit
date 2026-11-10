import type { Page } from '@playwright/test';

/** A page-side function, or a JSON value, that page-side code refers to by name. */
export type Helper = ((...args: never[]) => unknown) | string | number | readonly string[];

/** The source of a call to `main` with each helper of `kit` declared under its key. Playwright
 *  sends a function's source alone, so helpers name one another by kit key and import nothing. */
export const pageScript = <Arg>(
  kit: Readonly<Record<string, Helper>>,
  main: (arg: Arg) => unknown,
  arg?: Arg,
): string => {
  const scope = Object.entries(kit).map(
    ([name, helper]) =>
      `const ${name} = ${typeof helper === 'function' ? helper.toString() : JSON.stringify(helper)};`,
  );
  const call = `(${main.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
  return `(() => {\n${scope.join('\n')}\nreturn ${call};\n})()`;
};

/** Runs page-side functions with the helpers of `kit` in scope, as `pageScript` declares them. */
export const inPage =
  (page: Page, kit: Readonly<Record<string, Helper>>) =>
  async <Result, Arg = undefined>(
    main: (arg: Arg) => Result,
    arg?: Arg,
  ): Promise<Awaited<Result>> =>
    page.evaluate<Awaited<Result>>(pageScript(kit, main, arg));
