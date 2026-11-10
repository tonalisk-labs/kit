import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';

import type { Resource } from '../src/perf/collector.ts';
import { cpuSince } from '../src/perf/cpu.ts';
import { blockingOf, serialPhases } from '../src/perf/measure.ts';
import { splitReconnects } from '../src/perf/sockets.ts';
import { type Exchange, type Seen, staleOnCommit } from '../src/perf/traffic.ts';
import { encoded, forwardedNoneMatch } from '../src/stack/encode.ts';

await test('overlapping requests are one serial phase; each gap starts another', () => {
  assert.equal(serialPhases([]), 0);
  assert.equal(serialPhases([[0, 10]]), 1);
  assert.equal(
    serialPhases([
      [0, 10],
      [5, 20],
      [12, 15],
    ]),
    1,
  );
  assert.equal(
    serialPhases([
      [30, 40],
      [0, 10],
      [11, 20],
    ]),
    3,
  );
  assert.equal(
    serialPhases([
      [0, 10],
      [10, 20],
    ]),
    1,
  );
});

await test('a step’s CPU time counts from its start, or from a new process that took over', () => {
  assert.equal(cpuSince(1.5, 2), 0.5);
  assert.equal(cpuSince(1.5, 1.5), 0);
  assert.equal(cpuSince(3, 0.25), 0.25, 'a navigation swapped the process: its own time');
});

/** An upstream answer with these headers, as the edge receives it. */
const answer = (headers: Record<string, string>, status = 200): IncomingMessage => {
  const message = new IncomingMessage(new Socket());
  message.statusCode = status;
  message.headers = headers;
  return message;
};

const asked = (acceptEncoding: string, method = 'GET'): IncomingMessage => {
  const message = new IncomingMessage(new Socket());
  message.method = method;
  message.headers = { 'accept-encoding': acceptEncoding };
  return message;
};

const encodingOf = (incoming: IncomingMessage, upstream: IncomingMessage): unknown =>
  encoded(incoming, upstream, new Set()).headers['content-encoding'];

await test('the edge encodes as Caddy: zstd first, gzip else, compressible types over 512 B', () => {
  const page = { 'content-type': 'text/html; charset=utf-8', 'content-length': '4096' };
  assert.equal(encodingOf(asked('gzip, deflate, br, zstd'), answer(page)), 'zstd');
  assert.equal(encodingOf(asked('gzip, deflate'), answer(page)), 'gzip');
  assert.equal(encodingOf(asked('zstd;q=0.5, gzip'), answer(page)), 'gzip');
  assert.equal(encodingOf(asked('identity'), answer(page)), undefined);
  assert.equal(encodingOf(asked('gzip', 'HEAD'), answer(page)), undefined);
  const small = { 'content-type': 'application/json', 'content-length': '511' };
  assert.equal(encodingOf(asked('gzip'), answer(small)), undefined);
  const image = { 'content-type': 'image/jpeg', 'content-length': '40000' };
  assert.equal(encodingOf(asked('gzip'), answer(image)), undefined);
  assert.equal(encodingOf(asked('gzip'), answer(page, 304)), undefined);
  const { vary, 'content-length': length } = encoded(
    asked('gzip'),
    answer(page),
    new Set(),
  ).headers;
  assert.equal(length, undefined);
  assert.equal(vary, 'Accept-Encoding');
});

await test('the edge suffixes strong tags as Caddy, strips If-None-Match only', () => {
  const strong = encoded(
    asked('gzip, zstd'),
    answer({ 'content-type': 'application/json', 'content-length': '900', etag: '"5f2c"' }),
    new Set(),
  );
  assert.equal(strong.headers.etag, '"5f2c-zstd"');
  const weak = encoded(
    asked('gzip'),
    answer({ 'content-type': 'application/json', 'content-length': '900', etag: 'W/"3.4"' }),
    new Set(),
  );
  assert.equal(weak.headers.etag, 'W/"3.4"');
  const small = { 'content-type': 'application/json', 'content-length': '100', etag: '"5f2c"' };
  assert.equal(encoded(asked('gzip'), answer(small), new Set()).headers.etag, '"5f2c"');
  const conditional = (headers: Record<string, string>): IncomingMessage => {
    const message = asked('gzip, deflate, br, zstd');
    Object.assign(message.headers, headers);
    return message;
  };
  assert.equal(forwardedNoneMatch(conditional({ 'if-none-match': '"5f2c-zstd"' })), '"5f2c"');
  assert.equal(forwardedNoneMatch(conditional({ 'if-none-match': '"5f2c-gzip"' })), '"5f2c-gzip"');
  assert.equal(
    forwardedNoneMatch(conditional({ 'if-none-match': 'W/"5f2c-zstd"' })),
    'W/"5f2c-zstd"',
  );
  assert.equal(forwardedNoneMatch(conditional({ 'if-match': '"5f2c-zstd"' })), undefined);
});

const exchange = (path: string, at: number): Exchange => ({
  at,
  path,
  label: path,
  up: 0,
  down: 0,
  failed: false,
});

await test('a reconnect claims only its own paths; a save made meanwhile stays the step’s own', () => {
  const exchanges = [
    exchange('/api/v1/changes/tickets', 100),
    exchange('/api/v1/notes/n/updates', 150),
    exchange('/api/v1/changes', 300),
    exchange('/api/v1/account', 300),
    exchange('/api/v1/changes', 900),
  ];
  const calls = [
    ['/api/v1/changes/tickets', 99],
    ['/api/v1/notes/n/updates', 149],
    ['/api/v1/changes', 299],
    ['/api/v1/account', 299],
  ] as const;
  const paths = /\/(?:changes(?:\/tickets)?|account)$/u;
  const { own, reconnecting } = splitReconnects(exchanges, { calls, paths });
  assert.deepEqual(
    own.map(({ path, at }) => [path, at]),
    [
      ['/api/v1/notes/n/updates', 150],
      ['/api/v1/changes', 900],
    ],
  );
  assert.equal(reconnecting.length, 3);
  assert.equal(splitReconnects(exchanges, { calls, paths: undefined }).own.length, 5);
});

const resource = (start: number, end: number): Resource => ({
  url: `https://example.test/${String(start)}`,
  api: true,
  initiator: 'fetch',
  protocol: 'h2',
  start,
  end,
  waiting: 0,
  transfer: 0,
  encoded: 0,
  decoded: 0,
  serverTiming: [],
});

await test('only requests ending over a frame before the outcome blocked it', () => {
  const seen = { from: 100, visibleAt: 500 };
  const resources = [
    resource(90, 200),
    resource(120, 300),
    resource(150, 483),
    resource(160, 484),
    resource(200, 499),
    resource(300, 600),
  ];
  assert.deepEqual(
    blockingOf(resources, seen).map(({ start }) => start),
    [120, 150],
  );
});

await test('a new document drops the old one’s requests, and a navigation it superseded', () => {
  const page = { name: 'page' };
  const other = { name: 'other page' };
  const mainFrame = { page: (): unknown => page };
  const child = { page: (): unknown => page };
  /** Playwright's word for a request no service worker made. */
  const NO_WORKER: unknown = JSON.parse('null');
  const seen = (navigation: boolean, frame = mainFrame, worker = NO_WORKER): Seen => ({
    serviceWorker: () => worker,
    isNavigationRequest: () => navigation,
    frame: () => frame,
  });
  const on = { page, mainFrame, unanswered: false };
  assert.equal(staleOnCommit(seen(false), on), true, 'a fetch of the old document');
  assert.equal(staleOnCommit(seen(true), on), false, 'the navigation being answered');
  assert.equal(
    staleOnCommit(seen(true), { page, mainFrame, unanswered: true }),
    true,
    'a navigation still unanswered when another committed, as WebKit leaves one',
  );
  assert.equal(
    staleOnCommit(seen(true, child), { page, mainFrame, unanswered: true }),
    false,
    'a frame’s own navigation, which the page’s commit does not end',
  );
  assert.equal(
    staleOnCommit(seen(false, { page: (): unknown => other }), on),
    false,
    'another page’s',
  );
  assert.equal(staleOnCommit(seen(false, mainFrame, {}), on), false, 'a service worker’s');
});
