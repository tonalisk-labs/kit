import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLIENT_BOUNCE_TIMER,
  hasVisual,
  hostWorkers,
  launchOf,
  runsVisual,
  SETUP_TIMEOUT_MS,
  visualUseOf,
} from '../src/config.ts';
import { ROWS, type Row, tierRows } from '../src/matrix.ts';
import { MEASURE_ENV } from '../src/stack/control.ts';
import { SLOTS } from '../src/stack/gate-server.ts';

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-config-'));

const targetWith = async (name: string, spec: string): Promise<{ root: string }> => {
  const root = path.join(temporary.path, name);
  await mkdir(path.join(root, 'tests', 'journeys'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'journeys', 'a.spec.ts'), spec);
  return { root };
};

await test('a target has visual tests when any spec is tagged @visual', async () => {
  const tagged = await targetWith('tagged', "test('screen', { tag: '@visual' }, () => {});");
  const plain = await targetWith('plain', "test('flow', () => {});");
  assert.equal(hasVisual(tagged), true);
  assert.equal(hasVisual(plain), false);
});

await test('a run holds a worker per slot, a measured run two', () => {
  assert.equal(hostWorkers(), SLOTS);
  process.env[MEASURE_ENV] = '1';
  try {
    assert.equal(hostWorkers(), 2);
  } finally {
    Reflect.deleteProperty(process.env, MEASURE_ENV);
  }
});

/** `work` with `CI` set as given, restored after. */
const withCi = <Result>(ci: string | undefined, work: () => Result): Result => {
  const before = process.env['CI'];
  if (ci === undefined) {
    Reflect.deleteProperty(process.env, 'CI');
  } else {
    process.env['CI'] = ci;
  }
  try {
    return work();
  } finally {
    if (before === undefined) {
      Reflect.deleteProperty(process.env, 'CI');
    } else {
      process.env['CI'] = before;
    }
  }
};

await test('screens are held to their baselines in the full matrix, in CI on arm64 alone', () => {
  withCi('true', () => {
    assert.equal(runsVisual(undefined, 'arm64'), true);
    assert.equal(runsVisual(undefined, 'x64'), false);
    assert.equal(runsVisual('smoke', 'arm64'), false);
  });
  withCi(undefined, () => {
    assert.equal(runsVisual(undefined, 'x64'), true);
    assert.equal(runsVisual('dev', 'arm64'), false);
  });
});

await test('the measured tier is a desktop row and a phone row, both counting CPU time', () => {
  const rows = tierRows('measured');
  assert.deepEqual(
    rows.map((row) => [row.number, row.engine, row.form]),
    [
      [1, 'chromium', 'desktop'],
      [13, 'chromium', 'phone'],
    ],
  );
  assert.equal(tierRows('full').length, 16, 'a tier with no rows of its own is the whole matrix');
});

await test('Firefox alone is launched with a pref of its own: its client-bounce timer outlasts any load', () => {
  assert.deepEqual(launchOf('firefox'), {
    firefoxUserPrefs: { [CLIENT_BOUNCE_TIMER]: SETUP_TIMEOUT_MS },
  });
  assert.deepEqual(launchOf('chromium'), {});
  assert.deepEqual(launchOf('webkit'), {});
});

await test('a visual project runs its row with motion reduced, its screen class kept', () => {
  const target = { name: 'site', root: temporary.path, adapter: undefined };
  const [desktop, phone] = [ROWS[0], ROWS[12]];
  assert.ok(desktop !== undefined && phone !== undefined);
  const screen = { width: 393, height: 852 };
  const classed: Row = Object.assign(structuredClone(phone), {
    device: {
      id: 'phone-tall',
      options: {
        viewport: { width: 393, height: 659 },
        screen,
        userAgent: 'phone',
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  });
  for (const row of [desktop, phone]) {
    const use = visualUseOf(target, row);
    assert.deepEqual(
      [use.visual, use.contextOptions, use.row],
      [true, { reducedMotion: 'reduce' }, row],
    );
  }
  assert.deepEqual(visualUseOf(target, classed).contextOptions, {
    screen,
    reducedMotion: 'reduce',
  });
});
