import { control } from './control.ts';

/** Restarts a target's backend as a deploy would: SIGTERM, drained gracefully (live sockets close
 *  with 1001), then a fresh start on the same address. Resolves once it listens. */
export const restartBackend = async (site: string): Promise<void> => {
  await control('restart', site);
};
