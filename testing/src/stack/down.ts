// Upstreams the stack takes down on purpose, as a backend restart does: what reaches one meanwhile
// is refused, and the edge counts each refusal instead of saying it, as no fault.

/** Each upstream down on purpose, by port, with the refusals it has met. */
export type Downs = Map<number, { refused: number }>;

/** Whether `error` is a refusal by an upstream down on purpose, counting it if so. */
export const refusedOnPurpose = (downs: Downs, port: number, error: Error): boolean => {
  const down = downs.get(port);
  if (down === undefined || !('code' in error) || error.code !== 'ECONNREFUSED') {
    return false;
  }
  down.refused += 1;
  return true;
};

/** Runs `work` with the upstream on `port` down on purpose; resolves with the refusals it met. */
export const whileDown =
  (downs: Downs) =>
  async (port: number, work: () => Promise<void>): Promise<number> => {
    const down = { refused: 0 };
    downs.set(port, down);
    try {
      await work();
    } finally {
      downs.delete(port);
    }
    return down.refused;
  };
