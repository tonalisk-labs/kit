// The test files a workspace runs, found as `node --test` finds them, and split by whether they
// time code: a `.perf.test` file holds a wall-clock budget, so it runs alone and uninstrumented.
import { glob } from 'node:fs/promises';
import path from 'node:path';

/** `node --test`'s own default: what it runs when given no pattern. */
const DEFAULT_TESTS = '**/{test,test/**/*,test-*,*[._-]test}.{cjs,mjs,js,cts,mts,ts}';

const TIMED = /\.perf\.test\.[cm]?[jt]s$/u;

export interface TestFiles {
  readonly parallel: string[];
  readonly timed: string[];
}

/** The files `patterns` (or the default) name under `cwd`, the timed ones apart, each in order. */
export const testFiles = async (cwd: string, patterns: readonly string[]): Promise<TestFiles> => {
  const found = await Array.fromAsync(
    glob(patterns.length > 0 ? [...patterns] : [DEFAULT_TESTS], {
      cwd,
      exclude: (name) => name.split(path.sep).includes('node_modules'),
    }),
  );
  const files = [...new Set(found)].toSorted().map((file) => path.resolve(cwd, file));
  return {
    parallel: files.filter((file) => !TIMED.test(file)),
    timed: files.filter((file) => TIMED.test(file)),
  };
};

/** Which of a workspace's tests a run takes: both phases, the untimed ones with their floors, or
 *  the timed ones alone, for a run that has the machine to itself. */
export type Phase = 'both' | 'untimed' | 'timed';

/** The variable a run names its phase by; unset, it takes both. */
export const PHASE_ENV = 'KIT_TEST_PHASE';

/** The phase `value` names; any other word is refused, so a typo never skips a phase. */
export const phaseOf = (value: string | undefined): Phase => {
  if (value === undefined || value === '') {
    return 'both';
  }
  if (value === 'untimed' || value === 'timed') {
    return value;
  }
  throw new Error(`${PHASE_ENV} is untimed, timed or unset, not ${value}`);
};
