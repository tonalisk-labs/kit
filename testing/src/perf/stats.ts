// The statistics the perf reporter and the release audit share.

/** The middle value, or the mean of the two middle ones; 0 for none. */
export const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
