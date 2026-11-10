// Node's coverage names a module once for each time it is loaded: one imported afresh, as a test
// loads a page anew with `page.ts?load=2`, comes again under the same path, and Node's totals
// count its lines once per load. Here each file counts once, as Node counts a file loaded once.
// A line ran when any load ran it. A branch has no name that holds across loads, since V8 reports
// a block only where its count differs from the block around it, so a file loaded more than once
// counts its branches as the load that ran most of them counts them.

import type { Measured, Tally } from './hold.ts';

/** One load's coverage of a file, as Node's `test:coverage` summary reports it: every line but
 *  those a comment tells coverage to ignore, which Node counts in its totals as run. */
export interface FileCoverage {
  readonly path: string;
  readonly totalLineCount: number;
  readonly totalBranchCount: number;
  readonly coveredBranchCount: number;
  readonly lines: readonly { readonly line: number; readonly count: number }[];
}

/** A file's coverage over every load: whether each line ran, the lines ignored, and its branches
 *  in the load that ran most. */
interface Merged {
  readonly lines: Map<number, boolean>;
  readonly ignored: number;
  branches: Tally;
}

const mergeLoad = (into: Merged, load: FileCoverage): void => {
  for (const { line, count } of load.lines) {
    into.lines.set(line, into.lines.get(line) === true || count > 0);
  }
  if (load.coveredBranchCount > into.branches.covered) {
    into.branches = { covered: load.coveredBranchCount, count: load.totalBranchCount };
  }
};

const linesOf = ({ lines, ignored }: Merged): Tally => ({
  covered: [...lines.values()].filter(Boolean).length + ignored,
  count: lines.size + ignored,
});

const sum = (tallies: readonly Tally[]): Tally => ({
  covered: tallies.reduce((total, { covered }) => total + covered, 0),
  count: tallies.reduce((total, { count }) => total + count, 0),
});

/** The lines and branches of every file the tests loaded, each file counted once. */
export const measuredOnce = (loads: readonly FileCoverage[]): Measured => {
  const files = new Map<string, Merged>();
  for (const load of loads) {
    const merged = files.get(load.path) ?? {
      lines: new Map(),
      ignored: load.totalLineCount - load.lines.length,
      branches: { covered: load.coveredBranchCount, count: load.totalBranchCount },
    };
    mergeLoad(merged, load);
    files.set(load.path, merged);
  }
  const merged = [...files.values()];
  return {
    lines: sum(merged.map((file) => linesOf(file))),
    branches: sum(merged.map(({ branches }) => branches)),
  };
};
