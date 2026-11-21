#!/usr/bin/env node
// A workspace's tests as `node --test` runs them (its arguments: globs and `--import <module>`),
// those timing code then alone, one at a time, holding the machine's CPU gate whole once the
// machine is quiet; the rest under coverage, held to its floors. KIT_TEST_PHASE=untimed or timed
// takes one phase, so the timed run can have the machine alone.
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { run, type RunOptions } from 'node:test';
import { spec as SpecReporter } from 'node:test/reporters';
import { parseArgs } from 'node:util';

import { inWholeTurn } from '../stack/gate-member.ts';
import { GATE_PORT } from '../stack/gate-server.ts';
import { STILLNESS } from '../stack/stall.ts';
import { holdFloors, type Measured } from './hold.ts';
import { measuredOnce } from './instances.ts';
import { CEILING_ENV, ceilingOf, cpuSampler, quietBefore } from './quiet.ts';
import { PHASE_ENV, phaseOf, testFiles } from './timed.ts';

const { values, positionals } = parseArgs({
  options: { import: { type: 'string', multiple: true, default: [] } },
  allowPositionals: true,
});
const cwd = process.cwd();

const { parallel, timed } = await testFiles(cwd, positionals);

/** `files` run as `node --test` runs them, at once or one at a time, with Node's coverage of
 *  this folder's files when asked. */
const runOptions = (
  files: string[],
  { coverage, together }: { coverage: boolean; together: boolean },
): RunOptions => ({
  concurrency: together,
  coverage,
  coverageIncludeGlobs: [`${cwd}/**`],
  // What a workspace installs in its own node_modules isn't its code. Naming any exclusion drops
  // Node's default one, which leaves the test files out, so those are named as well.
  coverageExcludeGlobs: [`${cwd}/**/node_modules/**`, ...files],
  execArgv: values.import.flatMap((module) => ['--import', module]),
  files,
});

/** Runs `files` plainly, shown as `node --test` shows them; true when none failed. */
const passes = async (files: string[], together: boolean): Promise<boolean> => {
  let failed = false;
  const tests = run(runOptions(files, { coverage: false, together })).on('test:fail', () => {
    failed = true;
  });
  await pipeline(tests, new SpecReporter(), process.stdout, { end: false });
  return !failed;
};

/** The share of the workspace's own lines and branches the tests run, under Node's coverage,
 *  each file counted once however many times the tests load it. */
const measure = async (): Promise<Measured> => {
  let measured: Measured = measuredOnce([]);
  const tests = run(runOptions(parallel, { coverage: true, together: true })).on(
    'test:coverage',
    ({ summary: { files } }) => {
      measured = measuredOnce(files);
    },
  );
  await finished(tests.resume());
  return measured;
};

const name = process.env['npm_package_name'] ?? cwd;

/** The CPU gate's port: the machine's own, or the one a test of this runner serves. */
const GATE_PORT_ENV = 'KIT_CPU_GATE_PORT';

/** The most a timed pass waits for quiet: half the gate's stall, so a wait and the file it holds
 *  every slot for stay inside the stillness after which other runs' waits there fail. */
const QUIET_BOUND_MS = STILLNESS.stall / 2;

/** Runs each timed file in its own whole turn at the CPU gate, once the machine is quiet: load
 *  that starts mid-pass is waited out before the next file, and other runs' turns go on between. */
const timedEach = async (
  files: readonly string[],
  quiet: (what: string) => Promise<boolean>,
): Promise<boolean> => {
  const [file, ...rest] = files;
  if (file === undefined) {
    return true;
  }
  const passed = await inWholeTurn(
    async () => {
      await quiet(path.relative(cwd, file));
      return passes([file], false);
    },
    `the timed tests of ${name} (pid ${String(process.pid)})`,
    Number(process.env[GATE_PORT_ENV] ?? GATE_PORT),
  );
  return (await timedEach(rest, quiet)) && passed;
};

// Read before any test runs, so a ceiling mistyped fails the run at once.
const ceiling = ceilingOf(process.env[CEILING_ENV]);

/** Runs the timed files one at a time on cores no other run's tests share; the quiet is judged
 *  inside each turn, so the load it sees is none of the gate's own runs. */
const timedPass = async (files: readonly string[]): Promise<boolean> =>
  timedEach(
    files,
    quietBefore({
      sample: cpuSampler(),
      now: () => performance.now(),
      ceiling,
      bound: QUIET_BOUND_MS,
      say: (line) => {
        console.log(line);
      },
    }),
  );

const phase = phaseOf(process.env[PHASE_ENV]);
const untimed = phase !== 'timed';
const timedToo = phase !== 'untimed';
if (!timedToo && timed.length > 0) {
  console.log(
    `Timed test files left to their own run (${PHASE_ENV}=timed): ${String(timed.length)}`,
  );
}
// Said even when none is found, so a timed run of nothing reads as such.
if (!untimed) {
  console.log(`Timed test files run alone (${PHASE_ENV}=timed): ${String(timed.length)}`);
}
// A timed test shares no CPU with the others: it runs once they are done, and on its own.
const passed =
  (!untimed || (await passes(parallel, true))) &&
  (!timedToo || timed.length === 0 || (await timedPass(timed)));
process.exitCode = passed && (!untimed || holdFloors(name, cwd, await measure())) ? 0 : 1;
