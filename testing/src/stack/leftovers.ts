import { rmSync } from 'node:fs';

/** A runtime's synchronous removal of containers, which an exit handler can wait on. */
type RemoveNow = (ids: readonly string[]) => void;

const live = {
  groups: new Set<number>(),
  containers: new Map<string, RemoveNow>(),
  dirs: new Set<string>(),
};

/** The temp dirs go first: removing them cannot fail on a container runtime's account. */
const removeDirs = (): void => {
  for (const dir of live.dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A group gone between its exit and this handler is no error; anything else is told, never
 *  thrown, so the rest of the cleanup still runs. */
const killGroups = (): void => {
  for (const group of live.groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        console.error(`could not stop process group ${String(group)}:`, error);
      }
    }
  }
};

/** Each runtime removes its own at once, never throwing or waiting long: one that's down has
 *  nothing left to remove, and a hung one answers nothing. */
const removeContainers = (): void => {
  const byRuntime = new Map<RemoveNow, string[]>();
  for (const [id, remove] of live.containers) {
    byRuntime.set(remove, [...(byRuntime.get(remove) ?? []), id]);
  }
  for (const [remove, ids] of byRuntime) {
    remove(ids);
  }
};

/** The last resort, synchronous as an exit handler must be: a runner killed mid-teardown still
 *  leaves no process, container or temp dir behind. Normal stops empty these sets first. */
process.once('exit', () => {
  removeDirs();
  killGroups();
  removeContainers();
});

export const leftovers = {
  group: (pid: number | undefined): (() => void) => {
    if (pid !== undefined) {
      live.groups.add(pid);
    }
    return () => {
      if (pid !== undefined) {
        live.groups.delete(pid);
      }
    };
  },
  container: (id: string, remove: RemoveNow): (() => void) => {
    live.containers.set(id, remove);
    return () => {
      live.containers.delete(id);
    };
  },
  dir: (path: string): (() => void) => {
    live.dirs.add(path);
    return () => {
      live.dirs.delete(path);
    };
  },
};
