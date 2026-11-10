// Orbit granted on a real Postgres, as a stack's tests grant it: two grants at once both hold, and
// each one's handles enter Orbit on a later sign-up.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as later } from 'node:timers/promises';

import { sql } from '../src/database.ts';
import { grantOrbit } from '../src/orbit.ts';
import { execLine } from '../src/stack/containers.ts';
import { startPostgres } from '../src/stack/postgres.ts';
import type { Coordinates } from '../src/stack/stack.ts';

/** The two tables a grant writes, as the app's own migrations shape them. */
const SCHEMA = `CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), handle text);
CREATE TABLE orbit_grants (user_id uuid PRIMARY KEY REFERENCES users, reason text NOT NULL);`;

/** A stack with a database and nothing else. */
const coordinatesOf = (databaseUrl: string, databaseContainer: string): Coordinates => ({
  baseURL: 'https://localhost',
  trust: { ca: '', spki: '' },
  backendURL: undefined,
  siteDir: '',
  apiPrefix: undefined,
  databaseUrl,
  databaseContainer,
  mailpit: undefined,
  stripe: undefined,
  stripeSandbox: undefined,
  google: undefined,
  notices: [],
});

/** The first output a stream gives. */
const firstOf = async (stream: Readable): Promise<string> =>
  new Promise((resolve) => {
    stream.once('data', (chunk: Buffer) => {
      resolve(chunk.toString());
    });
  });

/** A session that holds `orbit_grants` until let go, so whatever reaches it first waits there
 *  with every lock it took before. */
const holdGrants = async ({
  databaseUrl = '',
  databaseContainer = '',
}: Coordinates): Promise<() => Promise<void>> => {
  const { username, pathname } = new URL(databaseUrl);
  const [command, ...args] = execLine(databaseContainer, [
    'psql',
    '-X',
    '-q',
    '-A',
    '-t',
    '-U',
    username,
    '-d',
    pathname.slice(1),
  ]);
  const session = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  session.stdin.write("BEGIN;\nLOCK TABLE orbit_grants IN EXCLUSIVE MODE;\nSELECT 'held';\n");
  const said = await firstOf(session.stdout);
  assert.equal(said.trim(), 'held');
  return async () => {
    session.stdin.end('COMMIT;\n');
    await once(session, 'exit');
  };
};

/** Answers once `count` sessions wait on a lock. */
const waitingOnLocks = async (coordinates: Coordinates, count: number): Promise<void> => {
  const [[waiting = '0'] = []] = await sql(
    coordinates,
    "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
  );
  if (Number(waiting) < count) {
    await later(50);
    await waitingOnLocks(coordinates, count);
  }
};

await test('two grants at once both hold, and each one’s handles enter Orbit on sign-up', async () => {
  const stop = new AbortController();
  const database = await startPostgres([{ name: 'app_user' }], stop.signal);
  try {
    const coordinates = coordinatesOf(database.ownerUrl, database.container);
    await sql(coordinates, SCHEMA);
    const letGo = await holdGrants(coordinates);
    const grants = Promise.allSettled([
      grantOrbit(coordinates, ['Ada-Lovelace']),
      grantOrbit(coordinates, ['grace_hopper']),
    ]);
    // Both are under way at once: the first waits on the held table, the second on the first.
    await waitingOnLocks(coordinates, 2);
    await letGo();
    const settled = await grants;
    assert.deepEqual(
      settled.map((grant) => grant.status),
      ['fulfilled', 'fulfilled'],
      settled
        .map((grant) => (grant.status === 'rejected' ? String(grant.reason) : 'held'))
        .join('; '),
    );
    await sql(coordinates, "INSERT INTO users (handle) VALUES ('ada-lovelace'), ('Grace_Hopper');");
    const granted = await sql(
      coordinates,
      'SELECT u.handle FROM orbit_grants g JOIN users u ON u.id = g.user_id ORDER BY lower(u.handle)',
    );
    assert.deepEqual(granted, [['ada-lovelace'], ['Grace_Hopper']]);
  } finally {
    await database.stop();
  }
});
