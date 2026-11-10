import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inPool } from '../src/script.ts';
import { calendar, startFakeGoogle } from '../src/stack/google.ts';
import { CONNECTS_AT_ONCE } from '../src/stack/ports.ts';

await test('each claim takes the first start no test holds, in one call, until none is left', async () => {
  const google = await startFakeGoogle();
  try {
    const fake = calendar(google.url);
    const starts = Array.from({ length: 200 }, (_unused, index) => `2026-10-01T${String(index)}`);
    const stop = new AbortController().signal;
    const claim = async (): Promise<string> => fake.claim(starts);
    const claimed = await inPool(starts, claim, { size: CONNECTS_AT_ONCE, stop });
    assert.deepEqual(claimed.toSorted(), starts.toSorted());
    assert.equal(await fake.claim(['fresh', ...starts]), 'fresh');
    await assert.rejects(fake.claim(starts), /every free start is claimed/u);
    await assert.rejects(fake.claim([]), /every free start is claimed/u);
  } finally {
    await google.stop();
  }
});

await test('a claim with a span keeps every start its span overlaps from others', async () => {
  const google = await startFakeGoogle();
  try {
    const fake = calendar(google.url);
    const long = { before: 10, after: 40 };
    assert.equal(await fake.claim(['2026-10-01T10:00:00Z'], long), '2026-10-01T10:00:00Z');
    const next = ['2026-10-01T10:30:00Z', '2026-10-01T11:00:00Z'];
    assert.equal(await fake.claim(next, { before: 5, after: 20 }), '2026-10-01T11:00:00Z');
    assert.equal(await fake.claim(['2026-10-01T10:45:00Z']), '2026-10-01T10:45:00Z');
  } finally {
    await google.stop();
  }
});
