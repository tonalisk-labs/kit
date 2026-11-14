// An upstream the stack takes down on purpose, as a backend restart does, refuses what reaches it
// meanwhile: the edge answers 502, counts the refusals and says nothing. At any other time, a
// refusal is a fault, said once.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:http2';
import { test } from 'node:test';

import { type Edge, startEdge } from '../src/stack/edge.ts';
import { fetchOver } from './edge-fetch.ts';

/** A loopback port nothing listens on: taken, then given back. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  return typeof address === 'object' && address !== null ? address.port : 0;
};

/** The lines the edge says from now until `restore`. */
const listened = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const report = console.error;
  console.error = (line: unknown): void => {
    lines.push(String(line));
  };
  return {
    lines,
    restore: () => {
      console.error = report;
    },
  };
};

const api = await closedPort();
const edge: Edge = await startEdge(
  {
    site: await closedPort(),
    api: { prefix: '/api', port: api },
    cacheControl: undefined,
    siteHost: undefined,
  },
  new AbortController().signal,
);
const session = connect(edge.origin, { ca: edge.trust.ca });
const asked = async (): Promise<number> => {
  const { status } = await fetchOver(session, { ':path': '/api/notes', ':method': 'GET' });
  return status;
};

try {
  await test('a refusal while its upstream is down on purpose is a 502, counted and not said', async () => {
    const said = listened();
    const statuses: number[] = [];
    try {
      const refused = await edge.whileDown(api, async () => {
        statuses.push(await asked(), await asked());
      });
      assert.equal(refused, 2);
    } finally {
      said.restore();
    }
    assert.deepEqual(statuses, [502, 502]);
    assert.deepEqual(said.lines, []);
  });

  await test('a refusal at any other time is a 502, said once', async () => {
    const said = listened();
    const status = await asked().finally(said.restore);
    assert.equal(status, 502);
    assert.deepEqual(said.lines, [
      `edge proxy: upstream connect ECONNREFUSED 127.0.0.1:${String(api)}`,
    ]);
  });
} finally {
  session.close();
  await edge.stop();
}
