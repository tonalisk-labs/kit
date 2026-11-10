// What a repo's command-line scripts share: how a script ends, steps run in turn or a few at a
// time, and reading parsed JSON of unknown shape without casts.
import { availableParallelism } from 'node:os';

import { reportStopped, stopSignal } from './stop.ts';

export { groupsOf } from '../../rules/source-text.ts';
export { reportStopped, stopSignal } from './stop.ts';
export { run, runShown, type Service, type SpawnOptions } from './stack/process.ts';

/** Runs `task` until it settles or a SIGINT or SIGTERM stops it. Its status is the exit code. */
export const runScript = async (
  name: string,
  task: (stop: AbortSignal) => Promise<number>,
): Promise<void> => {
  const stop = stopSignal();
  try {
    process.exitCode = await task(stop);
  } catch (error) {
    if (!stop.aborted) {
      throw error;
    }
  }
  if (stop.aborted) {
    reportStopped(name, stop);
  }
};

/** A step of a script: its exit status. */
export type Step = () => Promise<number>;

/** Runs each step in turn, and answers the first nonzero status, or 0. */
export const inTurn = async (steps: readonly Step[]): Promise<number> => {
  const [step, ...rest] = steps;
  if (step === undefined) {
    return 0;
  }
  const status = await step();
  return status === 0 ? inTurn(rest) : status;
};

/** 70% of the cores, at least one. */
const POOL_SIZE = Math.max(1, Math.floor(0.7 * availableParallelism()));

/** `work` on every item, `size` at a time, answered in item order. A stop takes no new item, and
 *  every lane is awaited before this settles. */
export const inPool = async <Item, Answer>(
  items: readonly Item[],
  work: (item: Item) => Promise<Answer>,
  { size = POOL_SIZE, stop }: { readonly size?: number; readonly stop: AbortSignal },
): Promise<Answer[]> => {
  const answers: Answer[] = [];
  const queue = items.entries();
  const lane = async (): Promise<void> => {
    const next = queue.next();
    if (next.done === true || stop.aborted) {
      return;
    }
    const [at, item] = next.value;
    answers[at] = await work(item);
    await lane();
  };
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(size, items.length) }, lane),
  );
  const failed = lanes.find((outcome) => outcome.status === 'rejected');
  if (failed !== undefined) {
    throw failed.reason;
  }
  stop.throwIfAborted();
  return answers;
};

/** This process's environment with `set` on top, for a child. */
export const environment = (set: Readonly<Record<string, string>>): NodeJS.ProcessEnv =>
  Object.assign(structuredClone(process.env), set);

/** An error's message with its causes, which is where fetch says why a connection failed. */
export const messageOf = (error: unknown): string =>
  error instanceof Error
    ? [error.message, ...(error.cause === undefined ? [] : [messageOf(error.cause)])].join(': ')
    : String(error);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const field = (value: unknown, key: string): unknown =>
  isObject(value) ? value[key] : undefined;

/** The string at `key`, or '' when there is none. */
export const text = (value: unknown, key: string): string => {
  const found = field(value, key);
  return typeof found === 'string' ? found : '';
};

/** The finite number at `key`, if there is one. */
export const numberOf = (value: unknown, key: string): number | undefined => {
  const found = field(value, key);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
};

/** `value` if it is an array, or none. */
export const items = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
