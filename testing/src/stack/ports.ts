import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { codeOf } from '../unknown.ts';
import { leftovers } from './leftovers.ts';
import type { Service } from './process.ts';
import { isGone, RUN } from './run.ts';

/** A loopback port free right now, for a process that must be told its port before it starts.
 *  Another process could take it before that one binds; the start then fails, and says so. */
export const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (typeof address !== 'object' || address === null) {
    throw new TypeError('the operating system gave no port');
  }
  return address.port;
};

/** A port the kit holds for a process it starts later, so no other kit process takes it first. */
export interface PortClaim extends Service {
  readonly port: number;
  /** The same release, synchronous, as an exit handler must be. */
  readonly releaseNow: () => void;
}

/** How many ports below the operating system's first ephemeral one the kit claims among. */
export const SPAN = 4096;

/** Connections one burst opens at once to a loopback server: half macOS's listen queue
 *  (kern.ipc.somaxconn, 128), which resets a connect past it while a starved server accepts. */
export const CONNECTS_AT_ONCE = 64;

/** Outside every repo and any TMPDIR a run sets, so every kit process on the machine meets it. */
const CLAIMS = path.join(homedir(), 'Library', 'Application Support', 'tonalisk-kit', 'ports');

/** A rename onto a port's folder that holds a claim fails with either code, as POSIX allows. */
const TAKEN = new Set<unknown>(['ENOTEMPTY', 'EEXIST']);
/** A sweep finds the claim gone already, or filled anew by another run. */
const GONE = new Set<unknown>(['ENOENT', 'ENOTEMPTY']);

/** The first port the operating system gives a port-0 listen or an outgoing connection. */
export const ephemeralFirst = (): number => {
  const read =
    platform() === 'linux'
      ? readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/u)[0]
      : spawnSync('sysctl', ['-n', 'net.inet.ip.portrange.first'], { encoding: 'utf8' }).stdout;
  const first = Number(read);
  if (!Number.isInteger(first) || first <= SPAN) {
    throw new TypeError(`the first ephemeral port reads ${String(read)}`);
  }
  return first;
};

const folderOf = (folder: string, port: number): string => path.join(folder, String(port));

/** The run whose claim holds `port`, if one does. */
const holderOf = (folder: string, port: number): string | undefined => {
  try {
    const [holder] = readdirSync(folderOf(folder, port));
    return holder === undefined ? undefined : decodeURIComponent(holder);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

/** A gone run's claim goes: its holder first, which only one sweeper can take, then its folder,
 *  unless a new claim has filled it meanwhile. */
const sweepGone = (folder: string, port: number): void => {
  const holder = holderOf(folder, port);
  if (holder === undefined || !isGone(holder)) {
    return;
  }
  const claim = folderOf(folder, port);
  for (const emptied of [path.join(claim, encodeURIComponent(holder)), claim]) {
    try {
      rmdirSync(emptied);
    } catch (error) {
      if (GONE.has(codeOf(error))) {
        return;
      }
      throw error;
    }
  }
};

/** A folder naming this run, made aside and renamed onto the port's place: only one process can,
 *  and only while no claim holds it. */
const claimed = (folder: string, port: number): boolean => {
  const aside = mkdtempSync(path.join(folder, '.claim-'));
  mkdirSync(path.join(aside, encodeURIComponent(RUN)));
  try {
    renameSync(aside, folderOf(folder, port));
    return true;
  } catch (error) {
    rmSync(aside, { recursive: true, force: true });
    if (TAKEN.has(codeOf(error))) {
      return false;
    }
    throw error;
  }
};

/** Whether the loopback takes a listen on `port` now: no process outside the kit holds it. */
const listenable = async (port: number): Promise<boolean> => {
  const server = createServer();
  server.listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch {
    return false;
  }
  server.close();
  await once(server, 'close');
  return true;
};

const claimOf = (folder: string, port: number): PortClaim => {
  const claim = folderOf(folder, port);
  const forget = leftovers.dir(claim);
  return {
    port,
    releaseNow: () => {
      rmSync(claim, { recursive: true, force: true });
      forget();
    },
    stop: async () => {
      await rm(claim, { recursive: true, force: true });
      forget();
    },
  };
};

/** Where a claim starts among the span, and the folder the kit's processes claim in. */
interface Search {
  readonly first: number;
  readonly start: number;
  readonly folder: string;
}

const claimFrom = async (search: Search, step = 0): Promise<PortClaim> => {
  const { first, start, folder } = search;
  if (step === SPAN) {
    throw new Error(`every port from ${String(first - SPAN)} to ${String(first - 1)} is held`);
  }
  const port = first - SPAN + ((start + step) % SPAN);
  sweepGone(folder, port);
  if (claimed(folder, port)) {
    const claim = claimOf(folder, port);
    if (await listenable(port)) {
      return claim;
    }
    claim.releaseNow();
  }
  return claimFrom(search, step + 1);
};

/** A loopback port below the range the operating system hands out, claimed among the kit's
 *  processes, for a process that must be told its port before it binds it. */
export const claimPort = async ({
  start = randomInt(SPAN),
  folder = CLAIMS,
}: { start?: number; folder?: string } = {}): Promise<PortClaim> => {
  mkdirSync(folder, { recursive: true });
  return claimFrom({ first: ephemeralFirst(), start, folder });
};
