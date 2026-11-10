// Run alone and uninstrumented, its budget in CPU time, as every timed test is.
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { diffSummary } from '../src/checks/visual-diff.ts';
import { cpuClock } from './cpu.ts';
import { encode, pictureOf } from './png.ts';

const SAME = 'no pixel differs over the shared area';

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'visual-diff-'));
const saved = async (name: string, png: Buffer): Promise<string> => {
  const file = path.join(temporary.path, name);
  await writeFile(file, png);
  return file;
};

await test('a full-HD screenshot pair decodes and compares in well under half a second of CPU', async () => {
  const picture = pictureOf(1920, 1080);
  const one = await saved(
    'large-one.png',
    encode(picture, (row) => row % 5),
  );
  const two = await saved(
    'large-two.png',
    encode(picture, (row) => (row + 1) % 5),
  );
  const spent = cpuClock();
  assert.equal(diffSummary(one, two), SAME);
  const took = spent();
  assert.ok(took < 400, `${String(Math.round(took))} ms of CPU`);
});
