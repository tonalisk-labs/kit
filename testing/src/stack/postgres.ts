import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { container, exec } from './containers.ts';
import type { Service } from './process.ts';
import type { ContainerSpec } from './runtime.ts';

/** A login role, optionally in a group role the app relies on. */
export interface Role {
  readonly name: string;
  readonly memberOf?: string;
}

export interface Database extends Service {
  /** The owner and superuser, which migrates and seeds. */
  readonly ownerUrl: string;
  /** Keyed by login role. */
  readonly urls: ReadonlyMap<string, string>;
  readonly container: string;
}

const IMAGE =
  'postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f';
const PORT = 5432;
const OWNER = 'owner';
const NAME = 'app';
/** The server's own log, one file from its start, as `container` can stop relaying its output
 *  at the entrypoint's exec of the server. */
const LOG_FILE = '/tmp/postgresql.log';
const LOGGING = [
  'logging_collector=on',
  `log_directory=${path.dirname(LOG_FILE)}`,
  `log_filename=${path.basename(LOG_FILE)}`,
  'log_rotation_size=0',
  'log_rotation_age=0',
].flatMap((setting) => ['-c', setting]);
/** The init's server listens on no TCP address, so only the real one writes the first. */
const READY = ['listening on IPv4 address', 'database system is ready to accept connections'];

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Group roles first, as NOLOGIN, so each login role can join its group as it is created. */
const bootstrap = (roles: readonly Role[], password: string): string => {
  const groups = [
    ...new Set(roles.flatMap(({ memberOf }) => (memberOf === undefined ? [] : [memberOf]))),
  ];
  return [
    ...groups.map((group) => `CREATE ROLE ${quoted(group)} NOLOGIN;`),
    ...roles.map(
      ({ name, memberOf }) =>
        `CREATE ROLE ${quoted(name)} LOGIN PASSWORD '${password}'${memberOf === undefined ? '' : ` IN ROLE ${quoted(memberOf)}`};`,
    ),
  ].join('\n');
};

/** The container of a database owned by OWNER, who signs in with `password`. */
const specOf = (password: string): ContainerSpec => ({
  image: IMAGE,
  ports: [PORT],
  ready: READY,
  logFile: LOG_FILE,
  command: ['postgres', ...LOGGING],
  env: { POSTGRES_USER: OWNER, POSTGRES_PASSWORD: password, POSTGRES_DB: NAME },
  // At 10 workers it peaked at 324 MiB, with no stall or OOM kill; 512 leaves it room.
  machine: { memory: 512, cpus: 4 },
});

export const startPostgres = async (
  roles: readonly Role[],
  signal: AbortSignal,
): Promise<Database> => {
  const password = randomBytes(16).toString('hex');
  const server = await container(specOf(password), signal);
  try {
    const sql = bootstrap(roles, password);
    await exec(
      server.id,
      ['psql', '-v', 'ON_ERROR_STOP=1', '-U', OWNER, '-d', NAME, '-c', sql],
      signal,
    );
  } catch (error) {
    await server.stop();
    throw error;
  }
  const { host, port } = server.address(PORT);
  const url = (role: string): string =>
    `postgres://${role}:${password}@${host}:${String(port)}/${NAME}`;
  return {
    ownerUrl: url(OWNER),
    urls: new Map(roles.map(({ name }) => [name, url(name)])),
    container: server.id,
    stop: server.stop,
  };
};
