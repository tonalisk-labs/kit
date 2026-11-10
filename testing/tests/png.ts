import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const chunk = (type: string, body: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  // The decoder skips the CRC, so any four bytes stand in for it.
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
};

const paeth = (left: number, up: number, corner: number): number => {
  const estimate = left + up - corner;
  const [toLeft, toUp, toCorner] = [
    Math.abs(estimate - left),
    Math.abs(estimate - up),
    Math.abs(estimate - corner),
  ];
  if (toLeft <= toUp && toLeft <= toCorner) {
    return left;
  }
  return toUp <= toCorner ? up : corner;
};

type Predictor = (left: number, up: number, corner: number) => number;

/** The predictor each PNG filter subtracts, from the byte's left, upper and upper-left bytes. */
const PREDICTORS: readonly Predictor[] = [
  () => 0,
  (left) => left,
  (_left, up) => up,
  (left, up) => Math.floor((left + up) / 2),
  paeth,
];

export interface Picture {
  readonly width: number;
  readonly height: number;
  /** RGB or RGBA bytes, row by row. */
  readonly bytes: Uint8Array;
  readonly channels: 3 | 4;
}

const byteOf = (bytes: Uint8Array, at: number, inside: boolean): number =>
  inside ? (bytes[at] ?? 0) : 0;

/** Row `down` as PNG filter `filter` writes it, its filter type byte first. */
const filterRow = (picture: Picture, down: number, filter: number): Uint8Array => {
  const { width, bytes, channels } = picture;
  const rowBytes = width * channels;
  const predict = PREDICTORS[filter] ?? PREDICTORS[0] ?? paeth;
  const row = new Uint8Array(rowBytes + 1);
  row[0] = filter;
  for (let at = 0; at < rowBytes; at += 1) {
    const here = down * rowBytes + at;
    const left = byteOf(bytes, here - channels, at >= channels);
    const up = byteOf(bytes, here - rowBytes, down > 0);
    const corner = byteOf(bytes, here - rowBytes - channels, at >= channels && down > 0);
    row[1 + at] = (byteOf(bytes, here, true) - predict(left, up, corner)) % 256;
  }
  return row;
};

/** A PNG of `picture`, each row with the filter `filterOf` names, its data split in two. */
export const encode = (picture: Picture, filterOf: (row: number) => number): Buffer => {
  const { width, height, channels } = picture;
  const rows = Array.from({ length: height }, (_row, down) =>
    filterRow(picture, down, filterOf(down)),
  );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const data = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', data.subarray(0, 100)),
    chunk('IDAT', data.subarray(100)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Deterministic noise between smooth runs, so every filter meets both kinds of neighbour. */
export const pictureOf = (width: number, height: number): Picture => {
  const bytes = new Uint8Array(width * height * 4);
  let seed = 12_345;
  for (let at = 0; at < bytes.length; at += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const noise = at % 7 === 0 ? seed % 256 : (at * 3) % 256;
    bytes[at] = at % 4 === 3 ? 255 : noise;
  }
  return { width, height, bytes, channels: 4 };
};
