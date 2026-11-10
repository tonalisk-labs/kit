import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { codeOf } from '../unknown.ts';
import { leftovers } from './leftovers.ts';

/** Swallows only a listen on IPv6 that the host refuses for having no IPv6 (a container): there
 *  `localhost` resolves to 127.0.0.1 alone, which the other listener already serves. */
export const withoutIpv6 = (error: unknown): void => {
  if (codeOf(error) !== 'EAFNOSUPPORT') {
    throw error;
  }
};

/** A file this user may run: access refuses one it may not with EACCES. */
const executable = (file: string): boolean => {
  const stats = statSync(file, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    return false;
  }
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch (error) {
    if (codeOf(error) !== 'EACCES') {
      throw error;
    }
    return false;
  }
};

export const which = (command: string): string | undefined =>
  (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((directory) => directory !== '')
    .map((directory) => path.join(directory, command))
    .find((file) => executable(file));

/** Something the stack started and must stop, awaiting the stop. */
export interface Service {
  readonly stop: () => Promise<void>;
}

export interface SpawnOptions {
  readonly signal: AbortSignal;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The child's stdin a pipe only this process holds, which ends when this process does, however
   *  it ends, even killed: a child that exits as it ends never outlives the stack. */
  readonly lifeline?: boolean;
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

/** Lines kept from a child's output, so a failure shows what the child said last. */
const TAIL_LINES = 60;

/** Keeps the child's last lines and calls `onLine` with each; reading also drains the pipes. */
const follow = (child: Child, onLine?: (line: string) => void): string[] => {
  const tail: string[] = [];
  for (const input of [child.stdout, child.stderr]) {
    createInterface({ input }).on('line', (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) {
        tail.shift();
      }
      if (onLine !== undefined) {
        onLine(line);
      }
    });
  }
  return tail;
};

/** How long a signalled child has to exit before its group is killed; as long as a container's stop. */
const GRACE_MS = 10_000;

/** Errors that mean the group is not ours to signal: gone, or its ID now someone else's. */
const NOT_OURS = new Set(['ESRCH', 'EPERM']);

/** Signals a process group. One gone or not ours is left alone; any other error is told, never
 *  thrown, as this also runs in exit handlers and timers. */
const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (typeof code !== 'string' || !NOT_OURS.has(code)) {
      console.error(`could not send ${signal} to process group ${String(pid)}:`, error);
    }
  }
};

/** Starts a child in its own group, so Ctrl-C reaches the harness alone, its stdin ended unless a
 *  lifeline. The group gets one SIGTERM as the leader exits, while its members keep the ID ours. */
const launch = (command: string, args: readonly string[], options: SpawnOptions): Child => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (options.lifeline !== true) {
    child.stdin.end();
  }
  const { pid } = child;
  if (pid !== undefined) {
    const forget = leftovers.group(pid);
    child.once('exit', () => {
      forget();
      signalGroup(pid, 'SIGTERM');
    });
  }
  return child;
};

const exited = (child: Child): boolean => child.exitCode !== null || child.signalCode !== null;

/** Past the grace period the group is killed. While the child runs, the group ID is still its
 *  own. */
const terminate = async (child: Child): Promise<void> => {
  const { pid } = child;
  if (exited(child) || pid === undefined) {
    return;
  }
  const exit = once(child, 'exit');
  signalGroup(pid, 'SIGTERM');
  const kill = setTimeout(() => {
    if (!exited(child)) {
      signalGroup(pid, 'SIGKILL');
    }
  }, GRACE_MS);
  try {
    await exit;
  } finally {
    clearTimeout(kill);
  }
};

const failure = (command: string, child: Child, tail: readonly string[]): Error =>
  new Error(
    `${command} exited with ${String(child.exitCode ?? child.signalCode)}:\n${tail.join('\n')}`,
  );

const settle = async (child: Child, signal: AbortSignal): Promise<void> => {
  const stop = (): void => {
    terminate(child).catch((error: unknown) => {
      console.error(error);
    });
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await once(child, 'close');
  } finally {
    signal.removeEventListener('abort', stop);
  }
};

export const run = async (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<string> => {
  options.signal.throwIfAborted();
  const child = launch(command, args, options);
  const chunks: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'));
  });
  const tail = follow(child);
  await settle(child, options.signal);
  options.signal.throwIfAborted();
  if (child.exitCode !== 0) {
    throw failure(command, child, tail);
  }
  return chunks.join('');
};

/** Shows the output as it comes, stderr joined to stdout, and answers the exit status. */
export const runShown = async (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<number> => {
  options.signal.throwIfAborted();
  const child = launch(command, args, options);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stdout, { end: false });
  await settle(child, options.signal);
  return child.exitCode ?? 1;
};

/** Starts a long-running child, resolved once its output has contained each `ready` text in order.
 *  A child that exits first, or a stop requested meanwhile, rejects once it is gone. */
export const serve = async (
  command: string,
  args: readonly string[],
  options: SpawnOptions & {
    readonly ready: readonly string[];
    readonly onLine?: (line: string) => void;
  },
): Promise<Service> => {
  options.signal.throwIfAborted();
  const child = launch(command, args, options);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const awaited = [...options.ready];
  const tail = follow(child, (line) => {
    if (awaited.length > 0 && line.includes(awaited[0] ?? '')) {
      awaited.shift();
    }
    if (awaited.length === 0) {
      resolve(true);
    }
    if (options.onLine !== undefined) {
      options.onLine(line);
    }
  });
  child.once('exit', () => {
    reject(failure(command, child, tail));
  });
  const abort = (): void => {
    reject(options.signal.reason);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    await promise;
  } catch (error) {
    await terminate(child);
    throw error;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
  return { stop: async () => terminate(child) };
};

/** The first whole line of `input` that `pick` accepts, however the stream splits its chunks;
 *  undefined once the stream ends without one. */
export const lineMatching = async (
  input: Readable,
  pick: (line: string) => boolean,
): Promise<string | undefined> => {
  const lines = createInterface({ input });
  try {
    for await (const line of lines) {
      if (pick(line)) {
        return line;
      }
    }
    return undefined;
  } finally {
    lines.close();
  }
};
