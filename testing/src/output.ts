import path from 'node:path';

/** The folder a run keeps its failed tests' output in, absolute or from the repo. */
export const OUTPUT_ENV = 'KIT_TESTING_OUTPUT';

/** A failed test's trace, error context and screenshots outlast the run, in the repo's
 *  `test-results` or where OUTPUT_ENV says; a passing test's go as it passes. */
export const outputOf = (
  repo: string,
): { readonly outputDir: string; readonly preserveOutput: 'failures-only' } => ({
  outputDir: path.resolve(repo, process.env[OUTPUT_ENV] ?? 'test-results'),
  preserveOutput: 'failures-only',
});
