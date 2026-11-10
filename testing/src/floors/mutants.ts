#!/usr/bin/env node
// Runs cargo mutants with the arguments given and holds each file it mutated to the mutation
// floor `mutants.json` gives it beside the workspace's Cargo.toml: the share of its mutants the
// tests caught, as a whole percent. A timeout counts as caught, and a mutant that doesn't build
// counts for nothing. A file mutated with no floor fails, told what it scored.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runShown } from '../stack/process.ts';
import { reportStopped, stopSignal } from '../stop.ts';

const FLOORS = 'mutants.json';
/** Where cargo mutants writes, as `output = "target"` in .cargo/mutants.toml sends it. */
const OUTCOMES = path.join('target', 'mutants.out', 'outcomes.json');

const member = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** How many of a file's mutants the tests ran, and how many of those they caught. */
export interface Score {
  readonly caught: number;
  readonly tested: number;
}

/** Each mutated file's score, from cargo mutants' outcomes. */
export const scoresOf = (outcomes: unknown): Map<string, Score> => {
  const scores = new Map<string, Score>();
  for (const outcome of list(member(outcomes, 'outcomes'))) {
    const mutant = member(member(outcome, 'scenario'), 'Mutant');
    const file = member(mutant, 'file');
    const summary = member(outcome, 'summary');
    if (
      typeof file === 'string' &&
      (summary === 'CaughtMutant' || summary === 'MissedMutant' || summary === 'Timeout')
    ) {
      const { caught, tested } = scores.get(file) ?? { caught: 0, tested: 0 };
      const held = summary === 'MissedMutant' ? 0 : 1;
      scores.set(file, { caught: caught + held, tested: tested + 1 });
    }
  }
  return scores;
};

/** One line per mutated file, and whether every file held its floor. */
export const judge = (
  scores: ReadonlyMap<string, Score>,
  floors: ReadonlyMap<string, unknown>,
): { lines: string[]; held: boolean } => {
  const verdicts = [...scores]
    .toSorted(([one], [other]) => (one < other ? -1 : 1))
    .map(([file, { caught, tested }]) => {
      const share = (100 * caught) / tested;
      const most = String(Math.floor(share));
      const shown = `${file}: ${String(caught)} of ${String(tested)} mutants caught, ${share.toFixed(1)}%`;
      const floor = floors.get(file);
      if (typeof floor !== 'number') {
        return {
          held: false,
          line: `${shown}; no floor in ${FLOORS}: give it one, at most ${most}`,
        };
      }
      if (share < floor) {
        return { held: false, line: `${shown}, below its floor of ${String(floor)}%` };
      }
      const raise = Math.floor(share) > floor ? `; raise its floor to ${most}` : '';
      return { held: true, line: `${shown}, floor ${String(floor)}%${raise}` };
    });
  return { lines: verdicts.map(({ line }) => line), held: verdicts.every(({ held }) => held) };
};

/** The floors a file holds, by the path of each file they hold. */
const floorsIn = (file: string): Map<string, unknown> => {
  const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return new Map(typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : []);
};

/** The exit status of a cargo-mutants run that exited `status`. A missed mutant exits 2 and a
 *  timeout 3, which the floors judge instead; a broken tree or baseline exits otherwise. */
const judgedStatus = (status: number): number => {
  if (status !== 0 && status !== 2 && status !== 3) {
    return status;
  }
  const outcomes: unknown = JSON.parse(readFileSync(OUTCOMES, 'utf8'));
  const { lines, held } = judge(scoresOf(outcomes), floorsIn(FLOORS));
  for (const line of lines) {
    console.log(line);
  }
  return held ? 0 : 1;
};

if (import.meta.main) {
  const stop = stopSignal();
  try {
    const status = await runShown('cargo', ['mutants', ...process.argv.slice(2)], { signal: stop });
    process.exitCode = judgedStatus(status);
  } catch (error) {
    if (!stop.aborted) {
      throw error;
    }
    reportStopped('floors/mutants', stop);
  }
}
