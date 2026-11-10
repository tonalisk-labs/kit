import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { devices } from '@playwright/test';

import { deviceRowsIn } from '../src/devices.ts';
import { deviceOf, ROWS, rowName, tierRows } from '../src/matrix.ts';

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'sites-testing-devices-'));

const PHONE = {
  id: 'iphone-402x874',
  platform: 'iphone',
  share: 32.6,
  playwright: {
    engines: ['webkit'],
    viewport: { width: 402, height: 714 },
    screen: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone)',
  },
};

const LAPTOP = {
  id: 'mac-1512x982',
  platform: 'mac',
  playwright: {
    engines: ['webkit', 'chromium', 'firefox'],
    viewport: { width: 1512, height: 945 },
    screen: { width: 1512, height: 982 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
};

/** The phone class, changed by `changes`. */
const phone = (changes: object): object => Object.assign(structuredClone(PHONE), changes);

/** The phone class, its Playwright values changed by `changes`. */
const phoneEmulating = (changes: object): object =>
  phone({ playwright: Object.assign(structuredClone(PHONE.playwright), changes) });

let repos = 0;

/** A repo whose spec/devices.json holds `body`. */
const repoWith = async (body: unknown): Promise<string> => {
  repos += 1;
  const root = path.join(temporary.path, `repo-${String(repos)}`);
  await mkdir(path.join(root, 'spec'), { recursive: true });
  await writeFile(path.join(root, 'spec', 'devices.json'), JSON.stringify(body));
  return root;
};

await test('a repo without a devices file adds no rows', () => {
  assert.deepEqual(deviceRowsIn(path.join(temporary.path, 'none'), 17), []);
});

await test("each class is a row per engine, numbered after the table's, named by its class", async () => {
  const rows = deviceRowsIn(await repoWith({ classes: [PHONE, LAPTOP] }), ROWS.length + 1);
  assert.deepEqual(
    rows.map((row) => rowName(row)),
    [
      '17-webkit-iphone-402x874',
      '18-webkit-mac-1512x982',
      '19-chromium-mac-1512x982',
      '20-firefox-mac-1512x982',
    ],
  );
  const [handheld, safari, chrome] = rows;
  assert.ok(handheld !== undefined && safari !== undefined && chrome !== undefined);
  assert.deepEqual(
    [handheld.form, handheld.orientation, handheld.cpu, handheld.network, handheld.gated],
    ['phone', 'portrait', 'high', 'wired', false],
  );
  assert.deepEqual(deviceOf(handheld), {
    viewport: { width: 402, height: 714 },
    screen: { width: 402, height: 874 },
    userAgent: 'Mozilla/5.0 (iPhone)',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  assert.equal(safari.form, 'laptop');
  assert.equal(safari.orientation, 'landscape');
  // A class with no agent of its own takes each engine's desktop one.
  assert.equal(deviceOf(safari).userAgent, devices['Desktop Safari'].userAgent);
  assert.equal(deviceOf(chrome).userAgent, devices['Desktop Chrome HiDPI'].userAgent);
  assert.deepEqual(deviceOf(chrome).viewport, { width: 1512, height: 945 });
});

await test("the devices tier is the classes' rows alone, the full matrix the table's then theirs", async () => {
  const rows = deviceRowsIn(await repoWith({ classes: [PHONE] }), ROWS.length + 1);
  assert.deepEqual(tierRows('devices', rows), rows);
  assert.deepEqual(tierRows(undefined, rows), [...ROWS, ...rows]);
  assert.deepEqual(tierRows('dev', rows), ROWS.slice(0, 3));
  assert.deepEqual(tierRows('smoke'), ROWS.slice(0, 1));
  assert.deepEqual(tierRows('full'), ROWS);
});

await test('a table row keeps every cell in its name', () => {
  const [first] = ROWS;
  assert.ok(first !== undefined);
  assert.equal(rowName(first), '01-chromium-desktop-landscape-high-wired');
});

const REFUSED: readonly (readonly [unknown, RegExp])[] = [
  [
    { classes: [phoneEmulating({ engines: ['firefox'] })] },
    /classes\[0\]\.playwright is mobile, which Firefox cannot emulate/u,
  ],
  [{ classes: [phone({ id: 'An iPhone' })] }, /classes\[0\]\.id is no lowercase name/u],
  [
    { classes: [phone({ platform: 'watch' })] },
    /classes\[0\]\.platform is none of iphone, ipad, mac/u,
  ],
  [
    { classes: [LAPTOP, phoneEmulating({ engines: ['opera'] })] },
    /classes\[1\]\.playwright\.engines names opera/u,
  ],
  [
    { classes: [phoneEmulating({ engines: [] })] },
    /classes\[0\]\.playwright\.engines names no engine/u,
  ],
  [
    { classes: [phoneEmulating({ viewport: { width: 0, height: 1 } })] },
    /classes\[0\]\.playwright\.viewport\.width is no positive number/u,
  ],
  [
    { classes: [phoneEmulating({ hasTouch: 'yes' })] },
    /classes\[0\]\.playwright\.hasTouch is neither true nor false/u,
  ],
  [
    { classes: [phoneEmulating({ userAgent: '' })] },
    /classes\[0\]\.playwright\.userAgent is no text/u,
  ],
  [{ classes: [phone({ playwright: [] })] }, /classes\[0\]\.playwright is no object/u],
  [{ classes: {} }, /spec\/devices\.json: classes is no list/u],
  [[], /the file is no object/u],
];

await test('a class Playwright cannot emulate is refused, by its path in the file', async () => {
  const roots = await Promise.all(REFUSED.map(async ([body]) => repoWith(body)));
  for (const [index, root] of roots.entries()) {
    const [, message] = REFUSED[index] ?? [undefined, /never/u];
    assert.throws(() => deviceRowsIn(root, 17), { message });
  }
});
