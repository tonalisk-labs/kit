// Each workspace or crate keeps `coverage.json` beside its manifest: whole-percent floors its
// tests must reach. Node measures lines and branches; Rust lines, regions and functions,
// since stable rustc has no branches, and a region is each arm a condition takes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FLOORS = 'coverage.json';
const METRICS = ['lines', 'branches', 'regions', 'functions'] as const;

/** How many lines, branches, regions or functions there are, and how many the tests ran. */
export interface Tally {
  readonly covered: number;
  readonly count: number;
}

export type Measured = Readonly<Partial<Record<(typeof METRICS)[number], Tally>>>;

/** What the floors say of a package's measured coverage: a line per metric measured, and whether
 *  all hold. */
export const judge = (
  name: string,
  measured: Measured,
  floors: ReadonlyMap<string, unknown>,
): { lines: string[]; held: boolean } => {
  const verdicts = METRICS.flatMap((metric) => {
    const tally = measured[metric];
    return tally === undefined ? [] : [verdict(`${name}: ${metric}`, tally, floors.get(metric))];
  });
  return {
    lines: verdicts.map(({ line }) => line),
    held: verdicts.every(({ held }) => held),
  };
};

/** One metric's share against its floor. */
const verdict = (
  named: string,
  { covered, count }: Tally,
  floor: unknown,
): { held: boolean; line: string } => {
  const share = count === 0 ? 100 : (100 * covered) / count;
  const most = String(Math.floor(share));
  const shown = `${named} ${share.toFixed(1)}% of ${String(count)}`;
  if (typeof floor !== 'number') {
    return { held: false, line: `${shown}; no floor in ${FLOORS}: give it one, at most ${most}` };
  }
  if (share < floor) {
    return { held: false, line: `${shown}, below its floor of ${String(floor)}%` };
  }
  const raise = Math.floor(share) > floor ? `; raise its floor to ${most}` : '';
  return { held: true, line: `${shown}, floor ${String(floor)}%${raise}` };
};

/** Holds a package's measured coverage to the floors beside its manifest; true when all hold. */
export const holdFloors = (name: string, folder: string, measured: Measured): boolean => {
  const file = path.join(folder, FLOORS);
  const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const floors = new Map(
    typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : [],
  );
  const { lines, held } = judge(name, measured, floors);
  for (const line of lines) {
    console.log(`    ${line}`);
  }
  if (!held) {
    console.error(`${name}'s coverage is below its floors (${file}).`);
  }
  return held;
};
