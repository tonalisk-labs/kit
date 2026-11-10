// The Linux image's browser server trusts the local CA by its certificate alone: nothing it is
// given, mounted or in its environment, holds a private key.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { browserServerSpec, deviceBudget, playwrightCore } from '../src/stack/browsers.ts';
import { localCaCertificate } from '../src/stack/tls.ts';

const KEY = /PRIVATE KEY/u;

/** The files under `dir` whose text holds a private key. */
const keysUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  const texts = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  return files.filter((_file, at) => KEY.test(texts[at] ?? ''));
};

await test("the browser image is given the CA's certificate alone, and no mount or variable holds a key", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'browsers-test-'));
  try {
    const caDir = path.join(folder, 'edge-ca');
    const ca = await localCaCertificate(caDir, new AbortController().signal);
    assert.match(ca, /^-----BEGIN CERTIFICATE-----/u);
    assert.deepEqual(await keysUnder(caDir), [path.join(caDir, 'ca.key')]);
    const spec = browserServerSpec(playwrightCore(), ca);
    assert.deepEqual(spec.env, {
      EDGE_CA: ca,
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/tonalisk-kit-edge.crt',
    });
    const [mounted] = spec.files ?? [];
    assert.ok(mounted !== undefined && !path.resolve(caDir).startsWith(path.resolve(mounted)));
    assert.deepEqual(await keysUnder(mounted), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

await test('three devices asked for together at 4 contexts are counted before any opens, and a fourth refused', async () => {
  const reserve = deviceBudget(4);
  // As the devices fixture does: the seat is counted, then the context is awaited.
  const open = async (): Promise<() => void> => {
    const giveBack = reserve();
    await Promise.resolve();
    return giveBack;
  };
  const [first] = await Promise.all([open(), open(), open()]);
  assert.throws(reserve, /at most 4 browser contexts open, its own included/u);
  first();
  first();
  const again = reserve();
  assert.throws(reserve, /declare more with test\.use\(\{ browserContexts \}\)/u);
  again();
  assert.throws(deviceBudget(1), /at most 1 browser contexts open/u);
});
