// What work costs, in the CPU time of the thread that runs it: a machine busy with other work
// slows the wall clock, not the work, so a timed test holds beside any other.

/** This thread's CPU time, to the microsecond. */
const threadCpu = (): NodeJS.CpuUsage => {
  // Linux counts a running thread's time at each 4 ms tick; reading the process's brings it to now.
  process.cpuUsage();
  return process.threadCpuUsage();
};

/** Starts counting; the function answers the CPU milliseconds this thread spent since. */
export const cpuClock = (): (() => number) => {
  const start = threadCpu();
  return () => {
    const { user, system } = threadCpu();
    return (user + system - start.user - start.system) / 1000;
  };
};
