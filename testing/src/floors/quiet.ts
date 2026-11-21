// Whether the machine is quiet of work kit's CPU gate never sees (other builds, simulators), read
// from its own CPU counters, so a timed test starts on idle cores or says that it didn't.
import { type CpuInfo, cpus } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/** The variable naming the ceiling: the share of the machine's CPU, in whole percent, that may be
 *  busy while it counts as quiet; 100 turns the wait off. */
export const CEILING_ENV = 'KIT_QUIET_CEILING';

/** A machine at rest stays well under a tenth busy; past a quarter, other work shares the caches,
 *  memory bandwidth and boost clocks a timed test is measured on. */
export const CEILING = 25;

/** A ceiling no share can pass, so there is nothing to wait for. */
const NO_CEILING = 100;

/** Each sample's window: every core's ticks move in it, and a burst of load still shows. */
export const WINDOW_MS = 500;

/** One sample can fall in a lull between another build's steps, so quiet takes a few in a row. */
export const QUIET_SAMPLES = 3;

/** The ceiling `value` names, the default when unset; any other word is refused, so a typo never
 *  times tests on a busy machine. */
export const ceilingOf = (value: string | undefined): number => {
  if (value === undefined || value === '') {
    return CEILING;
  }
  if (!/^(?:100|[1-9]?\d)$/u.test(value)) {
    throw new Error(`${CEILING_ENV} is a whole percentage from 0 to 100, not ${value}`);
  }
  return Number(value);
};

const busyTicks = ({ times: { user, nice, sys, irq } }: CpuInfo): number => user + nice + sys + irq;

/** The share, in percent, of the ticks every core counted between two readings that were busy; a
 *  platform that counts none shows no load, so it reads as idle. */
export const busyShare = (before: readonly CpuInfo[], after: readonly CpuInfo[]): number => {
  const moved = before.flatMap((core, index) => {
    const later = after[index];
    return later === undefined
      ? []
      : [
          {
            busy: busyTicks(later) - busyTicks(core),
            idle: later.times.idle - core.times.idle,
          },
        ];
  });
  const busy = moved.reduce((sum, ticks) => sum + ticks.busy, 0);
  const all = moved.reduce((sum, ticks) => sum + ticks.busy + ticks.idle, 0);
  return all === 0 ? 0 : (100 * busy) / all;
};

/** The machine's busy share over one window, read while this process only waits; `read` and `wait`
 *  stand for the machine's counters and its timer. */
export const cpuSampler =
  (
    read: () => readonly CpuInfo[] = cpus,
    wait: (ms: number) => Promise<unknown> = sleep,
  ): (() => Promise<number>) =>
  async () => {
    const before = read();
    await wait(WINDOW_MS);
    return busyShare(before, read());
  };

/** What a wait for quiet reads and says: the busy share over the next window, the time, the
 *  ceiling, the most a pass may wait in all, and where it speaks. */
export interface Quieting {
  readonly sample: () => Promise<number>;
  readonly now: () => number;
  readonly ceiling: number;
  readonly bound: number;
  readonly say: (line: string) => void;
}

/** One file's wait: what it waits for, since when, and for how long at most. */
interface Waiting {
  readonly what: string;
  readonly started: number;
  readonly bound: number;
}

/** How a wait ended: quiet or not, the last share seen, whether it said it was waiting, and how
 *  long it took. */
interface Settled {
  readonly quiet: boolean;
  readonly share: number;
  readonly waited: boolean;
  readonly took: number;
}

/** A wait's samples so far: how many in a row were at or under the ceiling, and whether it has said
 *  it is waiting. */
interface Seen {
  readonly inRow: number;
  readonly waited: boolean;
}

const UNSEEN: Seen = { inRow: 0, waited: false };

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))} s`;

const percent = (share: number): string => `${String(Math.round(share))}%`;

/** Samples until enough in a row are at or under the ceiling, or one is over it once the bound has
 *  passed; the first over it within the bound is said, once. */
const settle = async (
  quieting: Quieting,
  waiting: Waiting,
  { inRow, waited }: Seen = UNSEEN,
): Promise<Settled> => {
  const share = await quieting.sample();
  const took = quieting.now() - waiting.started;
  if (share <= quieting.ceiling) {
    return inRow + 1 >= QUIET_SAMPLES
      ? { quiet: true, share, waited, took }
      : settle(quieting, waiting, { inRow: inRow + 1, waited });
  }
  if (took >= waiting.bound) {
    return { quiet: false, share, waited, took };
  }
  if (!waited) {
    quieting.say(
      `${waiting.what} waits up to ${seconds(waiting.bound)} for the machine to go quiet: its ` +
        `CPU is ${percent(share)} busy, over the ${percent(quieting.ceiling)} ceiling ` +
        `(${CEILING_ENV})`,
    );
  }
  return settle(quieting, waiting, { inRow: 0, waited: true });
};

/** What a timed pass says of a file's wait: nothing for a machine quiet at once. */
const told = (quieting: Quieting, what: string, settled: Settled): string[] => {
  const share = percent(settled.share);
  if (!settled.quiet) {
    return [
      `${what} goes on, though the machine isn't quiet: its CPU is ${share} busy, over the ` +
        `${percent(quieting.ceiling)} ceiling, past the ${seconds(quieting.bound)} a timed pass ` +
        'waits; judge a failing timing by that load',
    ];
  }
  const took = seconds(settled.took);
  return settled.waited
    ? [`${what} goes on after ${took}: the machine is quiet, its CPU ${share} busy`]
    : [];
};

/** A timed pass's wait before each file, until the machine is quiet: the pass waits at most its
 *  bound in all, so lasting load costs it the bound once, not once per file. */
export const quietBefore = (quieting: Quieting): ((what: string) => Promise<boolean>) => {
  const pass = { spent: 0 };
  return async (what) => {
    if (quieting.ceiling >= NO_CEILING) {
      return true;
    }
    const bound = Math.max(0, quieting.bound - pass.spent);
    const settled = await settle(quieting, { what, started: quieting.now(), bound });
    pass.spent += settled.took;
    for (const line of told(quieting, what, settled)) {
      quieting.say(line);
    }
    return settled.quiet;
  };
};
