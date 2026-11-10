// The production edge's `encode zstd gzip` (Caddy), for the test edge: the same types, minimum
// and choice of encoding, so the bytes a journey moves are the bytes production moves.
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import type { Transform } from 'node:stream';
import { constants as zlib, createGzip, createZstdCompress } from 'node:zlib';

type Incoming = IncomingMessage | Http2ServerRequest;

/** The media types Caddy's `encode` compresses by default, as prefixes of `Content-Type`. */
const COMPRESSIBLE = [
  'application/atom+xml',
  'application/eot',
  'application/font',
  'application/geo+json',
  'application/graphql+json',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/opentype',
  'application/otf',
  'application/rss+xml',
  'application/truetype',
  'application/ttf',
  'application/vnd.api+json',
  'application/vnd.ms-fontobject',
  'application/wasm',
  'application/x-httpd-cgi',
  'application/x-javascript',
  'application/x-opentype',
  'application/x-otf',
  'application/x-perl',
  'application/x-protobuf',
  'application/x-ttf',
  'application/xhtml+xml',
  'application/xml',
  'font/',
  'image/svg+xml',
  'image/vnd.microsoft.icon',
  'image/x-icon',
  'multipart/bag',
  'multipart/mixed',
  'text/',
];

/** Caddy's `minimum_length`: a smaller body is sent as it is. */
const MIN_ENCODED_BYTES = 512;

type Encoding = 'zstd' | 'gzip';

/** The browser's weight for an encoding in `Accept-Encoding`, 0 when it does not take it. */
const weightOf = (accepted: string, encoding: Encoding): number => {
  const ranges = accepted.split(',').map((range) => range.trim().split(';'));
  const found = ranges.find(([name]) => name === encoding || name === '*');
  if (found === undefined) {
    return 0;
  }
  const quality = found.slice(1).find((parameter) => parameter.trim().startsWith('q='));
  return quality === undefined ? 1 : Number(quality.trim().slice(2));
};

/** Whether an answer has a body to encode: any final status but 204 and 304, to a request that
 *  is not HEAD. */
const hasBody = (incoming: Incoming, answer: IncomingMessage): boolean => {
  const status = answer.statusCode ?? 0;
  return incoming.method !== 'HEAD' && status >= 200 && status !== 204 && status !== 304;
};

/** Whether Caddy's `encode` would take this answer: a compressible type over the minimum, not
 *  already encoded, nor marked `no-transform`, with a body to encode. */
const encodable = (incoming: Incoming, answer: IncomingMessage): boolean => {
  const type = answer.headers['content-type'] ?? '';
  const length = answer.headers['content-length'];
  return (
    hasBody(incoming, answer) &&
    answer.headers['content-encoding'] === undefined &&
    !(answer.headers['cache-control'] ?? '').includes('no-transform') &&
    (length === undefined || Number(length) >= MIN_ENCODED_BYTES) &&
    COMPRESSIBLE.some((prefix) => type.startsWith(prefix))
  );
};

/** The encoding the browser prefers of production's `encode zstd gzip`: zstd on a tie. */
const preferred = (incoming: Incoming): Encoding | undefined => {
  const accepted = incoming.headers['accept-encoding'] ?? '';
  const [zstd, gzip] = [weightOf(accepted, 'zstd'), weightOf(accepted, 'gzip')];
  if (zstd > 0 && zstd >= gzip) {
    return 'zstd';
  }
  return gzip > 0 ? 'gzip' : undefined;
};

const encodingFor = (incoming: Incoming, answer: IncomingMessage): Encoding | undefined =>
  encodable(incoming, answer) ? preferred(incoming) : undefined;

/** The `If-None-Match` to forward, as Caddy's `encode` does: a strong tag ending in this request's
 *  encoding suffix loses it (caddyserver/caddy, modules/caddyhttp/encode/encode.go). */
export const forwardedNoneMatch = (incoming: Incoming): string | undefined => {
  const tag = incoming.headers['if-none-match'];
  const encoding = preferred(incoming);
  if (tag === undefined || encoding === undefined || tag.startsWith('W/')) {
    return tag;
  }
  const suffix = `-${encoding}"`;
  return tag.endsWith(suffix) ? `${tag.slice(0, -suffix.length)}"` : tag;
};

/** Caddy's levels: zstd's default (3) and gzip's 5. */
const encoderFor = (encoding: Encoding): Transform =>
  encoding === 'zstd'
    ? createZstdCompress({ params: { [zlib.ZSTD_c_compressionLevel]: 3 } })
    : createGzip({ level: 5 });

export const encoded = (
  incoming: Incoming,
  answer: IncomingMessage,
  hopByHop: ReadonlySet<string>,
): { readonly headers: OutgoingHttpHeaders; readonly encoder: Transform | undefined } => {
  const headers: OutgoingHttpHeaders = Object.fromEntries(
    Object.entries(answer.headers).filter(([name]) => !hopByHop.has(name)),
  );
  const encoding = encodingFor(incoming, answer);
  if (encoding === undefined) {
    return { headers, encoder: undefined };
  }
  const { vary } = answer.headers;
  delete headers['content-length'];
  delete headers['accept-ranges'];
  headers['content-encoding'] = encoding;
  // As Caddy: a strong tag names one representation, so the encoded one gets its own.
  const { etag } = answer.headers;
  if (etag !== undefined && !etag.startsWith('W/')) {
    headers.etag = `${etag.replace(/"$/u, '')}-${encoding}"`;
  }
  headers.vary = vary === undefined ? 'Accept-Encoding' : `${vary}, Accept-Encoding`;
  return { headers, encoder: encoderFor(encoding) };
};
