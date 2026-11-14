import { control } from './control.ts';

/** Restarts a target's backend as a deploy would (SIGTERM, drained, live sockets closed with 1001,
 *  started again), once it listens: how many requests met it down, each a 502 the edge counted. */
export const restartBackend = async (site: string): Promise<number> => {
  const { refused } = await control('restart', site);
  return Number(refused);
};
