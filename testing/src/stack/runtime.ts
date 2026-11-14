import { spawnSync } from 'node:child_process';

import { run, serve } from './process.ts';

/** What a container needs from the runtime that runs it. */
export interface ContainerSpec {
  readonly image: string;
  /** The ports the host reaches it on. */
  readonly ports: readonly number[];
  /** Log texts that mean ready, in the order the container writes them. */
  readonly ready: readonly string[];
  /** The texts come from concurrent servers, so their order varies from run to run. */
  readonly readyInAnyOrder?: boolean;
  /** The file in the container its service logs to, whose lines `ready` names, followed in place
   *  of the service's output, which `container` can stop relaying at an exec. */
  readonly logFile?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  /** A host directory the container reads from its start, as [host, container] paths. */
  readonly files?: readonly [string, string];
  /** An init that forwards signals and reaps the processes the command leaves. */
  readonly init?: boolean;
  /** Its processes share memory as a browser's do, past the 64 MB `/dev/shm` a container gets. */
  readonly sharesMemory?: boolean;
  /** Its own machine, where a runtime gives each container one: memory in MiB, and processors. */
  readonly machine?: { readonly memory: number; readonly cpus: number };
}

/** What a container's service says once ready, and where: its own log file, or its output. */
interface Said {
  readonly texts: readonly string[];
  readonly logFile?: string | undefined;
}

/** Where the host reaches a port a container listens on. */
export interface Address {
  readonly host: string;
  readonly port: number;
}

/** A running container's address and the host's, where a host server for it listens; `settled`
 *  is the global IPv6 address its network gives it seconds after it starts, if it gives one. */
export interface Network {
  readonly own: string;
  readonly host: string;
  readonly settled?: string | undefined;
}

/** How long each call may take on a busy machine, in milliseconds: a create may pull its image,
 *  and a container may take minutes to say it's ready. A hung daemon answers no call at all. */
export const LIMITS = {
  create: 600_000,
  copy: 120_000,
  start: 120_000,
  logs: 300_000,
  address: 30_000,
  network: 30_000,
  exec: 600_000,
  stop: 120_000,
  remove: 120_000,
  list: 30_000,
} as const;

export type Verb = keyof typeof LIMITS;

export type Limits = Readonly<Record<Verb, number>>;

/** A container runtime as a stack meets it. A create or a copy takes no caller's signal, since a
 *  remove always follows a container once created. */
export interface Runtime {
  readonly create: (
    spec: ContainerSpec,
    labels: Readonly<Record<string, string>>,
  ) => Promise<string>;
  /** Starts a created container with the files its spec names in place. */
  readonly start: (id: string, spec: ContainerSpec) => Promise<void>;
  readonly ready: (id: string, said: Said, signal: AbortSignal) => Promise<void>;
  readonly addresses: (
    id: string,
    ports: readonly number[],
  ) => Promise<ReadonlyMap<number, Address>>;
  readonly network: (id: string) => Promise<Network>;
  readonly exec: (id: string, command: readonly string[], signal: AbortSignal) => Promise<string>;
  /** The command line of an exec whose standard input its caller holds. */
  readonly execLine: (id: string, command: readonly string[]) => readonly [string, ...string[]];
  /** Every container, running or not, that carries label `key`, with the label's value. */
  readonly labelled: (key: string) => Promise<ReadonlyMap<string, string>>;
  readonly stop: (id: string) => Promise<void>;
  /** Removes containers, running or not, with every volume they made. */
  readonly remove: (ids: readonly string[]) => Promise<void>;
  /** The same, synchronous and bounded, as an exit handler must be. */
  readonly removeNow: (ids: readonly string[]) => void;
}

/** The memory a container's spec gives it, in MiB: `container`'s own default where it names none. */
const memoryOf = (spec: ContainerSpec): number =>
  spec.machine === undefined ? 1024 : spec.machine.memory;

/** The `/dev/shm` a spec that shares memory takes on either runtime: half its machine, as a tmpfs
 *  takes by default, holding only what's written to it. */
export const sharedMemoryOf = (spec: ContainerSpec): string[] =>
  spec.sharesMemory === true ? ['--shm-size', `${String(Math.floor(memoryOf(spec) / 2))}M`] : [];

/** The flags both runtimes take alike: each label and environment variable as `key=value`. */
export const pairsOf = (
  flag: '--env' | '--label',
  pairs: Readonly<Record<string, string>> = {},
): string[] => Object.entries(pairs).flatMap(([key, value]) => [flag, `${key}=${value}`]);

/** A call that met the hung daemon, past its limit or after another call did. */
export class RuntimeHungError extends Error {
  public override readonly name = 'RuntimeHungError';
}

/** The signal that ends a limit: on the wall clock, as the daemon it bounds is outside this
 *  process, or as a test fires it. */
export type Expiry = (ms: number) => AbortSignal;

export const onTheClock: Expiry = (ms) => AbortSignal.timeout(ms);

/** A runtime's command line: its program, its word for each verb, what a hang means, and when
 *  each verb's limit ends. */
export interface Cli {
  readonly command: string;
  readonly verbs: Readonly<Record<Verb, string>>;
  readonly hung: string;
  /** What a remove adds to the ids, so nothing a container made stays behind. */
  readonly removeFlags: readonly string[];
  readonly limits?: Limits | undefined;
  readonly expiry?: Expiry | undefined;
}

/** A runtime's calls, and the parts of it that each runtime's command line spells alike. */
export interface Caller extends Pick<
  Runtime,
  'ready' | 'exec' | 'execLine' | 'remove' | 'removeNow'
> {
  readonly call: (verb: Verb, args: readonly string[], signal?: AbortSignal) => Promise<string>;
}

/** A read of a container's whole output, bounded as a service that hangs would never answer it. */
const LOG_READ_MS = 30_000;

/** What a container's output relay held as its readiness ran out, read whole rather than
 *  followed, so a failure tells a service that wrote nothing from a relay that stopped. */
const relayedIn = async (command: string, verb: string, id: string): Promise<string> => {
  try {
    const logged = await run(command, [verb, id], { signal: AbortSignal.timeout(LOG_READ_MS) });
    const lines = logged.split('\n').filter((line) => line !== '');
    const last = lines.at(-1);
    return last === undefined
      ? 'its output held nothing'
      : `its output held ${String(lines.length)} lines, the last: ${last}`;
  } catch (error) {
    return `its output could not be read: ${String(error)}`;
  }
};

type Verbs = Readonly<Record<Verb, string>>;

/** Makes the file, unless it is there, without emptying it and writable by the service's own
 *  user: GNU tail follows a file by inotify only if it exists as tail starts, else it polls. */
const FOLLOW = 'umask 0 && : >> "$1" && exec tail -n +1 -F "$1"';

/** The command line that follows what a container says: its own log file through an exec, or
 *  its output through the runtime's relay. */
const followerOf = (verbs: Verbs, id: string, logFile: string | undefined): string[] =>
  logFile === undefined
    ? [verbs.logs, '--follow', id]
    : [verbs.exec, id, 'sh', '-c', FOLLOW, 'sh', logFile];

/** Waits on what a container says as it is written, so readiness is an event, not a poll, until
 *  it says the texts or its limit passes. */
const readyOf =
  (command: string, verbs: Verbs, limit: { readonly ms: number; readonly expiry: Expiry }) =>
  async (id: string, { texts, logFile }: Said, signal: AbortSignal): Promise<void> => {
    const bound = limit.expiry(limit.ms);
    try {
      const followed = await serve(command, followerOf(verbs, id, logFile), {
        ready: texts,
        signal: AbortSignal.any([signal, bound]),
      });
      await followed.stop();
    } catch (error) {
      if (bound.aborted && !signal.aborted) {
        const said = `${JSON.stringify(texts)}${logFile === undefined ? '' : ` to ${logFile}`}`;
        const within = `within ${String(limit.ms / 1000)} s`;
        const relayed = await relayedIn(command, verbs.logs, id);
        throw new Error(`container ${id} wrote none of ${said} ${within}; ${relayed}`, {
          cause: error,
        });
      }
      throw error;
    }
  };

/** Every call within its verb's limit until one hangs; after that, every call fails at once, so
 *  the run ends and frees its slots. */
const callOf = ({
  command,
  verbs,
  hung,
  limits = LIMITS,
  expiry = onTheClock,
}: Cli): Caller['call'] => {
  const daemon = { hung: '' };
  return async (verb, args, signal = new AbortController().signal) => {
    const said = `${command} ${verbs[verb]}`;
    if (daemon.hung !== '') {
      throw new RuntimeHungError(`${said} not tried: ${daemon.hung}`);
    }
    const bound = expiry(limits[verb]);
    try {
      const output = await run(command, [verbs[verb], ...args], {
        signal: AbortSignal.any([signal, bound]),
      });
      return output.trim();
    } catch (error) {
      if (bound.aborted && !signal.aborted) {
        daemon.hung = `${said} gave no answer within ${String(limits[verb] / 1000)} s: ${hung}`;
        throw new RuntimeHungError(daemon.hung, { cause: error });
      }
      throw error;
    }
  };
};

/** A runtime's calls through its command line. The exit handler's remove can't wait on a daemon
 *  that may be hung, so it's bounded and never throws. */
export const callerOf = (cli: Cli): Caller => {
  const { command, verbs, removeFlags, limits = LIMITS, expiry = onTheClock } = cli;
  const call = callOf(cli);
  return {
    call,
    ready: readyOf(command, verbs, { ms: limits.logs, expiry }),
    exec: async (id, line, signal) => call('exec', [id, ...line], signal),
    execLine: (id, line) => [command, verbs.exec, '-i', id, ...line],
    remove: async (ids) => {
      await call('remove', [...removeFlags, ...ids]);
    },
    removeNow: (ids) => {
      spawnSync(command, [verbs.remove, ...removeFlags, ...ids], {
        stdio: 'ignore',
        timeout: 30_000,
      });
    },
  };
};
