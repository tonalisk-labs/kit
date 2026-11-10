// A site without Starlight loads kit/astro, as built: nothing behind the entry resolves Starlight
// until a Starlight helper is called.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../../dist/theme/astro.js', import.meta.url));

/** Fails every resolution of a Starlight module, as a site without Starlight would. */
const WITHOUT_STARLIGHT = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@astrojs/starlight')) {
      throw new Error('no Starlight here: ' + specifier);
    }
    return next(specifier, context);
  },
});
`)}`;

await test('kit/astro loads where Starlight is not installed', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      WITHOUT_STARLIGHT,
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(ENTRY)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
});
