#!/usr/bin/env node
// Runs the workspace's tests under cargo llvm-cov, each crate held to the floors beside its
// Cargo.toml (hold.ts) for its lines, regions and functions; a crate no test runs, such as a fuzz
// target's, has none.
import path from 'node:path';

import { run, runShown, type SpawnOptions } from '../stack/process.ts';
import { reportStopped, stopSignal } from '../stop.ts';
import { holdFloors, type Measured, type Tally } from './hold.ts';

const member = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** What cargo llvm-cov's summary counts, each held to its own floor. */
const METRICS = ['lines', 'regions', 'functions'] as const;

const tallyOf = (files: readonly unknown[], metric: string): Tally => {
  let covered = 0;
  let count = 0;
  for (const file of files) {
    const counts = member(member(file, 'summary'), metric);
    covered += Number(member(counts, 'covered') ?? 0);
    count += Number(member(counts, 'count') ?? 0);
  }
  return { covered, count };
};

const measuredOf = (files: readonly unknown[]): Measured =>
  Object.fromEntries(METRICS.map((metric) => [metric, tallyOf(files, metric)]));

export interface Crate {
  readonly name: string;
  readonly folder: string;
}

/** Each crate's lines, regions and functions from cargo llvm-cov's JSON summary, its files being
 *  those in its folder and in no crate nested there; a crate with no file measured has none. */
export const coverageByCrate = (
  report: unknown,
  crates: readonly Crate[],
): Map<string, Measured> => {
  const deepestFirst = crates.toSorted((one, other) => other.folder.length - one.folder.length);
  const crateOf = (file: unknown): string => {
    const name = String(member(file, 'filename'));
    const crate = deepestFirst.find(({ folder }) => name.startsWith(folder + path.sep));
    return crate === undefined ? '' : crate.name;
  };
  const data = list(member(report, 'data')).at(0);
  const files = Map.groupBy(list(member(data, 'files')), crateOf);
  return new Map(
    crates.flatMap(({ name }) => {
      const own = files.get(name);
      return own === undefined ? [] : [[name, measuredOf(own)] as const];
    }),
  );
};

/** Each workspace crate's name and folder. */
const cratesOf = async (options: SpawnOptions): Promise<Crate[]> => {
  const metadata: unknown = JSON.parse(
    await run('cargo', ['metadata', '--format-version', '1', '--no-deps'], options),
  );
  return list(member(metadata, 'packages')).map((crate) => ({
    name: String(member(crate, 'name')),
    folder: path.dirname(String(member(crate, 'manifest_path'))),
  }));
};

/** Runs the workspace's tests for coverage and holds each crate to its floors; 0 when all hold.
 *  The report reads every binary and profile left in its target: a clean start keeps old ones out. */
const coverCrates = async (options: SpawnOptions): Promise<number> => {
  await run('cargo', ['llvm-cov', 'clean', '--workspace'], options);
  const tested = await runShown(
    'cargo',
    ['llvm-cov', '--no-report', '--workspace', '--all-features'],
    options,
  );
  if (tested !== 0) {
    return tested;
  }
  const report: unknown = JSON.parse(
    await run('cargo', ['llvm-cov', 'report', '--json', '--summary-only'], options),
  );
  const crates = await cratesOf(options);
  const measured = coverageByCrate(report, crates);
  const held = crates.flatMap(({ name, folder }) => {
    const own = measured.get(name);
    return own === undefined ? [] : [holdFloors(name, folder, own)];
  });
  return held.every(Boolean) ? 0 : 1;
};

if (import.meta.main) {
  const stop = stopSignal();
  try {
    process.exitCode = await coverCrates({ signal: stop });
  } catch (error) {
    if (!stop.aborted) {
      throw error;
    }
    reportStopped('floors/rust', stop);
  }
}
