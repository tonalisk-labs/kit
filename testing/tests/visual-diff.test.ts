import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { diffSummary } from '../src/checks/visual-diff.ts';
import { encode, type Picture, pictureOf } from './png.ts';

const SAME = 'no pixel differs over the shared area';

const cycle = (row: number): number => row % 5;

/** The same pixels as RGB, dropping the opaque alpha. */
const rgbOf = ({ width, height, bytes }: Picture): Picture => ({
  width,
  height,
  bytes: bytes.filter((_byte, at) => at % 4 !== 3),
  channels: 3,
});

await using temporary = await mkdtempDisposable(path.join(tmpdir(), 'visual-diff-'));
const saved = async (name: string, png: Buffer): Promise<string> => {
  const file = path.join(temporary.path, name);
  await writeFile(file, png);
  return file;
};

await test('every filter decodes to the same pixels, in RGB and RGBA', async () => {
  const picture = pictureOf(37, 23);
  const plain = await saved(
    'plain.png',
    encode(picture, () => 0),
  );
  const cycled = await saved(
    'cycled.png',
    encode(picture, (row) => row % 5),
  );
  const rgb = await saved(
    'rgb.png',
    encode(rgbOf(picture), (row) => (row + 2) % 5),
  );
  assert.equal(diffSummary(plain, cycled), SAME);
  assert.equal(diffSummary(cycled, rgb), SAME);
});

await test('changed pixels are counted and boxed, whatever filter carries them', async () => {
  const picture = pictureOf(40, 30);
  const changed = Uint8Array.from(picture.bytes);
  for (const [across, down, channel] of [
    [3, 5, 0],
    [20, 5, 3],
    [11, 17, 2],
  ] as const) {
    const at = (down * 40 + across) * 4 + channel;
    changed[at] = ((changed[at] ?? 0) + 1) % 256;
  }
  const before = await saved(
    'before.png',
    encode(picture, (row) => (row * 3) % 5),
  );
  const edited: Picture = Object.assign(structuredClone(picture), { bytes: changed });
  const after = await saved('after.png', encode(edited, cycle));
  assert.equal(diffSummary(before, after), '3 pixels differ (0.250%), within x 3–20, y 5–17');
});

await test('images of different sizes compare over the area both cover', async () => {
  const wide = pictureOf(30, 10);
  const cropped: Picture = {
    width: 20,
    height: 8,
    channels: 4,
    bytes: Uint8Array.from({ length: 20 * 8 * 4 }, (_byte, at) => {
      const [down, rest] = [Math.floor(at / 80), at % 80];
      return wide.bytes[down * 120 + rest] ?? 0;
    }),
  };
  const one = await saved(
    'wide.png',
    encode(wide, (row) => row % 5),
  );
  const two = await saved(
    'cropped.png',
    encode(cropped, () => 4),
  );
  assert.equal(diffSummary(one, two), `${SAME}; size 30×10 → 20×8`);
});
