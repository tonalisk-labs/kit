import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overlaps, type TextLine } from '../src/checks/text.ts';

const lineAt = (
  [left, top]: readonly [number, number],
  lineage: string,
  text: string,
): TextLine => ({
  left,
  top,
  right: left + 40,
  bottom: top + 10,
  clips: [],
  lineage,
  text,
});

/** Every pair checked, in the sorted order the check reports them. */
const everyPair = (lines: readonly TextLine[]): string[] => {
  const boxes = lines
    .filter((box) => box.right - box.left > 1 && box.bottom - box.top > 1)
    .toSorted((one, other) => one.top - other.top);
  return boxes.flatMap((box, index) =>
    boxes
      .filter((_other, at) => at > index)
      .filter(
        (other) =>
          !other.lineage.startsWith(`${box.lineage}/`) &&
          !box.lineage.startsWith(`${other.lineage}/`) &&
          other.lineage !== box.lineage,
      )
      .filter((other) => {
        const width = Math.min(other.right, box.right) - Math.max(other.left, box.left);
        const height = Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top);
        return width > 0 && height > 0 && width * height > 80;
      })
      .map((other) => `"${box.text}" overlaps "${other.text}"`),
  );
};

await test('overlapping lines of unrelated elements are reported, related ones are not', () => {
  const lines = [
    lineAt([0, 0], '/0/1', 'one'),
    lineAt([10, 5], '/0/2', 'two'),
    lineAt([10, 5], '/0/1/0', 'child of one'),
    lineAt([0, 9], '/0/3', 'touching'),
    lineAt([200, 0], '/0/4', 'apart'),
  ];
  assert.deepEqual(overlaps(lines), [
    '"one" overlaps "two"',
    '"two" overlaps "child of one"',
    '"two" overlaps "touching"',
    '"child of one" overlaps "touching"',
  ]);
});

await test('the sweep reports exactly what checking every pair does', () => {
  let seed = 7;
  const next = (range: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % range;
  };
  const lines = Array.from({ length: 400 }, (_line, at) =>
    lineAt([next(300), next(600)], `/0/${String(next(40))}`, `line ${String(at)}`),
  );
  assert.deepEqual(overlaps(lines), everyPair(lines));
});
