// How a command-line script stops: the first SIGHUP, SIGINT or SIGTERM aborts its work, which
// exits with the conventional status (128 plus the signal's number), never with a partial report.
// A hang-up, as from a closed terminal or a wrapper passing its own on, would otherwise end Node
// at once, before the work's clean-up.

const SIGNALLED = 128;

/** The signals that stop a script, and their numbers. */
const NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

type Stopping = keyof typeof NUMBERS;

const STOPPING: readonly Stopping[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];

/** Where the signals are heard: the process, or anything that emits their names as it does. */
interface Signals {
  on: (name: Stopping, listener: () => void) => unknown;
}

/** An abort signal raised by the first SIGHUP, SIGINT or SIGTERM, its reason the signal name. The
 *  listeners stay, so a library that re-raises unheard signals (signal-exit) cannot end the run. */
export const stopSignal = (signals: Signals = process): AbortSignal => {
  const shutdown = new AbortController();
  for (const name of STOPPING) {
    signals.on(name, () => {
      shutdown.abort(name);
    });
  }
  return shutdown.signal;
};

/** The status a run that `name` stopped exits with; a reason that names no signal is a SIGTERM. */
export const stoppedStatus = (name: string): number => {
  const known = STOPPING.find((one) => one === name);
  return SIGNALLED + NUMBERS[known ?? 'SIGTERM'];
};

/** Says `script` stopped on the signal `stop` carries, and sets the exit status to match. */
export const reportStopped = (script: string, stop: AbortSignal): void => {
  const name = String(stop.reason);
  console.error(`${script}: stopped by ${name}; no report.`);
  process.exitCode = stoppedStatus(name);
};
