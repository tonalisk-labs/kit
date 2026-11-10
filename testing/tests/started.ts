import type { Service } from '../src/stack/process.ts';

type Started<Starts extends readonly Promise<Service>[]> = {
  -readonly [Index in keyof Starts]: Awaited<Starts[Index]>;
};

/** Every start, or the first failure once each start that went through has stopped again, so a
 *  test whose start fails leaves nothing running to hold its file's process open. */
export const startedAll = async <const Starts extends readonly Promise<Service>[]>(
  starts: Starts,
): Promise<Started<Starts>> => {
  const settled = await Promise.allSettled(starts);
  const failed = settled.find((one) => one.status === 'rejected');
  if (failed !== undefined) {
    await Promise.all(
      settled.map(async (one) => (one.status === 'fulfilled' ? one.value.stop() : undefined)),
    );
    throw failed.reason;
  }
  return Promise.all(starts);
};
