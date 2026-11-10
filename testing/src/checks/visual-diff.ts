import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** An image as 8-bit RGBA rows. */
interface Image {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** The PNG signature: 0x89, `PNG`, CR LF, Ctrl-Z, LF. */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Bytes per pixel of the colour types Playwright writes: RGB and RGBA, 8 bits a channel. */
const CHANNELS: Readonly<Record<number, number>> = { 2: 3, 6: 4 };

interface Chunks {
  readonly header: Buffer;
  readonly data: Buffer;
}

/** The IHDR chunk and every IDAT chunk's bytes, joined. */
const chunksOf = (bytes: Buffer): Chunks => {
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  const found: { header?: Buffer; data: Buffer[] } = { data: [] };
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      found.header = body;
    } else if (type === 'IDAT') {
      found.data.push(body);
    }
    at += 12 + length;
  }
  if (found.header === undefined) {
    throw new Error('a PNG file without its IHDR chunk');
  }
  return { header: found.header, data: Buffer.concat(found.data) };
};

const paeth = (left: number, up: number, corner: number): number => {
  const estimate = left + up - corner;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toCorner = Math.abs(estimate - corner);
  if (toLeft <= toUp && toLeft <= toCorner) {
    return left;
  }
  return toUp <= toCorner ? up : corner;
};

interface Row {
  readonly filter: number;
  readonly raw: Uint8Array;
  readonly previous: Uint8Array;
  readonly stride: number;
}

/** The byte `back` places before `at` in `bytes`, or 0 before the scanline starts. */
const before = (bytes: Uint8Array, at: number, back: number): number =>
  at >= back ? (bytes[at - back] ?? 0) : 0;

/** Undoes one PNG filter type on a scanline in place. A Uint8Array keeps each sum modulo 256. */
type Unfilter = (line: Uint8Array, previous: Uint8Array, stride: number) => Uint8Array;

const unSub: Unfilter = (line, _previous, stride) => {
  for (let at = stride; at < line.length; at += 1) {
    line[at] = (line[at] ?? 0) + (line[at - stride] ?? 0);
  }
  return line;
};

const unUp: Unfilter = (line, previous) => {
  for (let at = 0; at < line.length; at += 1) {
    line[at] = (line[at] ?? 0) + (previous[at] ?? 0);
  }
  return line;
};

const unAverage: Unfilter = (line, previous, stride) => {
  for (let at = 0; at < line.length; at += 1) {
    const average = Math.floor((before(line, at, stride) + (previous[at] ?? 0)) / 2);
    line[at] = (line[at] ?? 0) + average;
  }
  return line;
};

const unPaeth: Unfilter = (line, previous, stride) => {
  for (let at = 0; at < line.length; at += 1) {
    const predicted = paeth(
      before(line, at, stride),
      previous[at] ?? 0,
      before(previous, at, stride),
    );
    line[at] = (line[at] ?? 0) + predicted;
  }
  return line;
};

/** One tight loop per filter type, by the type's number. Type 0 leaves the bytes as they are. */
const UNFILTERS: readonly Unfilter[] = [(line) => line, unSub, unUp, unAverage, unPaeth];

/** One scanline's bytes with its filter undone. */
const unfiltered = ({ filter, raw, previous, stride }: Row): Uint8Array => {
  const unfilter = UNFILTERS[filter];
  if (unfilter === undefined) {
    throw new Error(`a PNG scanline with unknown filter ${String(filter)}`);
  }
  return unfilter(new Uint8Array(raw), previous, stride);
};

const opaque = (line: Uint8Array, row: Uint8Array): void => {
  for (let across = 0; across * 3 < line.length; across += 1) {
    row[across * 4] = line[across * 3] ?? 0;
    row[across * 4 + 1] = line[across * 3 + 1] ?? 0;
    row[across * 4 + 2] = line[across * 3 + 2] ?? 0;
    row[across * 4 + 3] = 255;
  }
};

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG, as Playwright writes its screenshots. */
const decode = (bytes: Buffer): Image => {
  const { header, data } = chunksOf(bytes);
  const [width, height] = [header.readUInt32BE(0), header.readUInt32BE(4)];
  const [depth, colour, interlace] = [header[8], header[9] ?? 0, header[12]];
  const stride = CHANNELS[colour];
  if (depth !== 8 || interlace !== 0 || stride === undefined) {
    throw new Error(`an unsupported PNG: depth ${String(depth)}, colour type ${String(colour)}`);
  }
  const inflated = inflateSync(data);
  const pixels = new Uint8Array(width * height * 4);
  const rowBytes = width * stride;
  let previous: Uint8Array = new Uint8Array(rowBytes);
  for (let down = 0; down < height; down += 1) {
    const start = down * (rowBytes + 1);
    const raw = inflated.subarray(start + 1, start + 1 + rowBytes);
    const line = unfiltered({ filter: inflated[start] ?? 0, raw, previous, stride });
    if (stride === 4) {
      pixels.set(line, down * rowBytes);
    } else {
      opaque(line, pixels.subarray(down * width * 4, (down + 1) * width * 4));
    }
    previous = line;
  }
  return { width, height, pixels };
};

interface Spread {
  count: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The image's pixels as one 32-bit word each; `decode` allocates them word-aligned. */
const wordsOf = ({ pixels }: Image): Uint32Array =>
  new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);

/** The image's row `down`, cut to `width` pixels, as bytes over its own memory. */
const rowOf = (image: Image, down: number, width: number): Buffer =>
  Buffer.from(image.pixels.buffer, image.pixels.byteOffset + down * image.width * 4, width * 4);

/** The pixels that differ in any channel over the area both images cover, and their bounds:
 *  equal rows are skipped with one memory compare, the rest compared a pixel word at a time. */
const differing = (expected: Image, actual: Image): Spread => {
  const spread: Spread = {
    count: 0,
    left: Number.POSITIVE_INFINITY,
    top: Number.POSITIVE_INFINITY,
    right: -1,
    bottom: -1,
  };
  const [width, height] = [
    Math.min(expected.width, actual.width),
    Math.min(expected.height, actual.height),
  ];
  const [one, two] = [wordsOf(expected), wordsOf(actual)];
  for (let down = 0; down < height; down += 1) {
    const same = rowOf(expected, down, width).equals(rowOf(actual, down, width));
    for (let across = same ? width : 0; across < width; across += 1) {
      if (one[down * expected.width + across] !== two[down * actual.width + across]) {
        spread.count += 1;
        spread.left = Math.min(spread.left, across);
        spread.top = Math.min(spread.top, down);
        spread.right = Math.max(spread.right, across);
        spread.bottom = Math.max(spread.bottom, down);
      }
    }
  }
  return spread;
};

/** What changed between a baseline and the screenshot that failed it, for stdout: the pixel
 *  count, their share of the image, and the box that holds them. */
export const diffSummary = (expectedPath: string, actualPath: string): string => {
  const [expected, actual] = [decode(readFileSync(expectedPath)), decode(readFileSync(actualPath))];
  const size =
    expected.width === actual.width && expected.height === actual.height
      ? ''
      : `; size ${String(expected.width)}×${String(expected.height)} → ${String(actual.width)}×${String(actual.height)}`;
  const spread = differing(expected, actual);
  if (spread.count === 0) {
    return `no pixel differs over the shared area${size}`;
  }
  const share =
    (100 * spread.count) /
    (Math.min(expected.width, actual.width) * Math.min(expected.height, actual.height));
  const box = `x ${String(spread.left)}–${String(spread.right)}, y ${String(spread.top)}–${String(spread.bottom)}`;
  return `${String(spread.count)} pixels differ (${share.toFixed(3)}%), within ${box}${size}`;
};
