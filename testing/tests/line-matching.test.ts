import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { lineMatching } from '../src/stack/process.ts';

const healthy = (line: string): boolean => line.includes('health_status: healthy');

await test('a status split across chunks is still found', async () => {
  const input = new PassThrough();
  const found = lineMatching(input, healthy);
  for (const chunk of ['health_status: star', 'ting\nhealth_sta', 'tus: hea', 'lthy\n']) {
    input.write(chunk);
  }
  input.end();
  assert.equal(await found, 'health_status: healthy');
});

await test('a stream that ends without the line answers undefined', async () => {
  const input = new PassThrough();
  const found = lineMatching(input, healthy);
  input.end('health_status: unhealthy\ndie\n');
  assert.equal(await found, undefined);
});
