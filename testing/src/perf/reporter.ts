import { appendFileSync, readFileSync } from 'node:fs';
import { styleText } from 'node:util';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';

import { isObject } from '../unknown.ts';
import { ceiling, minimumScore } from './budgets.ts';
import { SlowFiles } from './slow-files.ts';
import {
  FAILURE_ATTACHMENT,
  isMeasured,
  JOURNEY_ATTACHMENT,
  type Measured,
  STEPS_ATTACHMENT,
} from './steps.ts';
import { didNotRun, type ProjectTally, unrunReport, workerNamed } from './unrun.ts';

interface Column {
  readonly id: string;
  readonly label: string;
  readonly kind: 'ms' | 'shift' | 'score';
}

const COLUMNS: readonly Column[] = [
  { id: 'time-to-first-byte', label: 'TTFB', kind: 'ms' },
  { id: 'first-contentful-paint', label: 'FCP', kind: 'ms' },
  { id: 'largest-contentful-paint', label: 'LCP', kind: 'ms' },
  { id: 'cumulative-layout-shift', label: 'CLS', kind: 'shift' },
  { id: 'interaction-to-next-paint', label: 'INP', kind: 'ms' },
  { id: 'interaction-cpu', label: 'CPU/int', kind: 'ms' },
  { id: 'performance', label: 'Perf', kind: 'score' },
  { id: 'accessibility', label: 'A11y', kind: 'score' },
  { id: 'best-practices', label: 'BP', kind: 'score' },
];

interface Stat {
  readonly median: number;
  readonly deviation: number;
}

/** The median and the sample standard deviation (n − 1). */
const statOf = (values: readonly number[]): Stat => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return { median, deviation: values.length > 1 ? Math.sqrt(squares / (values.length - 1)) : 0 };
};

/** The share of its budget a median uses: 1 is exactly the budget. A score held at 100 has no room
 *  to use: any shortfall is over it. */
const usage = ({ id, kind }: Column, { median }: Stat): number => {
  if (kind !== 'score') {
    return median / ceiling(id);
  }
  const room = 100 - minimumScore(id);
  if (room === 0) {
    return median < 100 ? Number.POSITIVE_INFINITY : 0;
  }
  return (100 - median) / room;
};

const cell = (column: Column, values: readonly number[]): string => {
  if (values.length === 0) {
    return '–';
  }
  const stat = statOf(values);
  const digits = column.kind === 'shift' ? 3 : 0;
  const unit = column.kind === 'ms' ? ' ms' : '';
  const spread = stat.deviation.toFixed(digits);
  const used = usage(column, stat);
  const share = Number.isFinite(used) ? `${String(Math.round(used * 100))}%` : 'under 100';
  return `${stat.median.toFixed(digits)} ±${spread}${unit} (${share})${used <= 1 ? '' : ' ✗'}`;
};

const rowOf = (step: string, byMetric: ReadonlyMap<string, readonly number[]>): string[] => {
  const samples = Math.max(...[...byMetric.values()].map((values) => values.length));
  return [
    step,
    String(samples),
    ...COLUMNS.map((column) => cell(column, byMetric.get(column.id) ?? [])),
  ];
};

/** One Markdown table row, its pipes escaped. */
const markdownRow = (cells: readonly string[]): string =>
  `| ${cells.map((text) => text.replaceAll('|', String.raw`\|`)).join(' | ')} |`;

/** Rows as a Markdown table, the first its headings: what a CI run's summary page shows. */
export const markdownTable = (rows: readonly (readonly string[])[]): string[] => {
  const [headings = [], ...body] = rows;
  return [
    markdownRow(headings),
    markdownRow(headings.map(() => '---')),
    ...body.map((row) => markdownRow(row)),
  ];
};

/** The file a GitHub Actions step's summary is read from, when the run is one. */
const STEP_SUMMARY = 'GITHUB_STEP_SUMMARY';

const table = (rows: readonly (readonly string[])[]): string[] => {
  const widths = (rows[0] ?? []).map((_heading, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows.map(
    (row) => `  ${row.map((text, column) => text.padEnd(widths[column] ?? 0)).join('  ')}`,
  );
};

/** A measured journey step as `measureStep` attached it. */
interface JourneyMeasure {
  readonly target: string;
  readonly row: string;
  readonly step: string;
  readonly metrics: Readonly<Record<string, number>>;
}

const isJourneyMeasure = (value: unknown): value is JourneyMeasure =>
  isObject(value) &&
  ['target', 'row', 'step'].every((name) => typeof value[name] === 'string') &&
  isObject(value['metrics']);

/** The JSON an attachment named `wanted` carries, or nothing for any other. */
const attachedJson = (
  { name, body }: TestResult['attachments'][number],
  wanted: string,
): unknown =>
  name === wanted && body !== undefined ? JSON.parse(body.toString('utf8')) : undefined;

const KIB = 1024;

/** The stretch tier: a third of Google's "good", reported and never failing. */
const STRETCH = 3;

const count = (metrics: Readonly<Record<string, number>>, id: string): string => {
  const value = metrics[id];
  return value === undefined ? '–' : String(Math.round(value));
};

const kib = (metrics: Readonly<Record<string, number>>, id: string): string => {
  const value = metrics[id];
  return value === undefined ? '–' : (value / KIB).toFixed(1);
};

/** A timing with its stretch tier: `*` within a third of its "good" budget. */
const timing = (metrics: Readonly<Record<string, number>>, id: string, audit?: string): string => {
  const value = metrics[id];
  if (value === undefined) {
    return '–';
  }
  const stretch = audit !== undefined && value <= ceiling(audit) / STRETCH;
  return `${String(Math.round(value))}${stretch ? '*' : ''}`;
};

const journeyRow = ({ row, step, metrics }: JourneyMeasure): string[] => [
  step,
  row.slice(0, 2),
  count(metrics, 'requests'),
  `${count(metrics, 'blocking')} (${count(metrics, 'blockingApi')})`,
  count(metrics, 'serialPhases'),
  kib(metrics, 'bytesUp'),
  kib(metrics, 'bytesDown'),
  `${count(metrics, 'wsFrames')} (${count(metrics, 'feedFrames')}/${count(metrics, 'relayFrames')})`,
  count(metrics, 'sockets'),
  `${count(metrics, 'reconnects')} (${kib(metrics, 'reconnectBytes')})`,
  timing(metrics, 'visibleMs'),
  timing(metrics, 'lcp', 'largest-contentful-paint'),
  timing(metrics, 'inp', 'interaction-to-next-paint'),
  timing(metrics, 'loafMs'),
  count(metrics, 'cpuMs'),
];

const JOURNEY_HEADINGS = [
  'Journey step',
  'Row',
  'Req',
  'Block (API)',
  'Phases',
  'Up KiB',
  'Down KiB',
  'WS (feed/relay)',
  'Sockets',
  'Reconnect req (KiB)',
  'Visible ms',
  'LCP',
  'INP',
  'LoAF ms',
  'CPU ms',
];

/** The parts of a test step the failure report reads. */
interface Stepped {
  readonly title: string;
  readonly category: string;
  readonly error?: { readonly message?: string } | undefined;
  readonly steps: readonly Stepped[];
}

/** Each failed assertion's titles from the test down, with its message's first line. */
export const failedPaths = (
  steps: readonly Stepped[],
  path: string[] = [],
  found: string[] = [],
): string[] => {
  for (const step of steps) {
    path.push(step.title);
    if (step.error !== undefined && step.category === 'expect') {
      found.push(`  ${path.join(' › ')}: ${(step.error.message ?? '').split('\n')[0] ?? ''}`);
    }
    failedPaths(step.steps, path, found);
    path.pop();
  }
  return found;
};

/** Lines of a failure's page snapshot printed at most, enough for the screen's dialogs. */
const SNAPSHOT_LINES = 150;

/** The page as Playwright saw it at the failure (its error-context file, in temp output removed
 *  on exit), from its page snapshot on, cut to a readable length. */
const pageSnapshot = (result: TestResult): string[] =>
  result.attachments
    .filter(({ name, path }) => name === 'error-context' && path !== undefined)
    .flatMap(({ path = '' }) => {
      const text = readFileSync(path, 'utf8');
      const at = text.indexOf('# Page snapshot');
      const lines = (at === -1 ? text : text.slice(at)).trimEnd().split('\n');
      const shown = lines.slice(0, SNAPSHOT_LINES).map((line) => `  ${line}`);
      if (lines.length > SNAPSHOT_LINES) {
        shown.push(`  … ${String(lines.length - SNAPSHOT_LINES)} more lines`);
      }
      return shown;
    });

/** What a config hands the reporter: the setup's file, which the slow-file report leaves out. */
export interface StdoutOptions {
  readonly setupFile?: string;
}

/** Prints each failure's assertions and page, the slow files, then each target's journeys and steps
 *  (median ± SD, share of "good"); it only reports, and in GitHub Actions writes a run's summary. */
export default class StdoutReporter implements Reporter {
  readonly #setupFile: string | undefined;

  #slowFiles = new SlowFiles('');

  public constructor({ setupFile }: StdoutOptions = {}) {
    this.#setupFile = setupFile;
  }

  /** The run's summary page, in Markdown, written once the run ends. */
  readonly #summary: string[] = [];

  #printJourneys(): void {
    if (this.#journeys.length === 0) {
      return;
    }
    console.log(
      '\nMeasured journeys: requests, those the outcome waited for and their serial phases, bytes, live-socket frames, and apart from them the requests reconnecting dropped sockets; * marks the stretch tier (a third of "good").',
    );
    for (const target of new Set(this.#journeys.map((journey) => journey.target))) {
      const rows = this.#journeys
        .filter((journey) => journey.target === target)
        .toSorted(
          (one, other) => one.step.localeCompare(other.step) || one.row.localeCompare(other.row),
        )
        .map((journey) => journeyRow(journey));
      console.log(
        [styleText('bold', target), ...table([JOURNEY_HEADINGS, ...rows]), ''].join('\n'),
      );
      this.#summary.push(
        `### Measured journeys: ${target}`,
        '',
        ...markdownTable([JOURNEY_HEADINGS, ...rows]),
        '',
      );
    }
  }

  readonly #measured = new Map<string, Map<string, Map<string, number[]>>>();

  readonly #journeys: JourneyMeasure[] = [];

  #projects: readonly { readonly name: string; readonly dependencies: readonly string[] }[] = [];

  #suite: Suite | undefined;

  /** Each worker's last test, to name the one a worker error is about. */
  readonly #lastTests = new Map<number, string>();

  /** Errors outside any test, which make Playwright count no later dependency as passed. */
  readonly #runErrors: string[] = [];

  public onBegin(config: FullConfig, suite: Suite): void {
    this.#slowFiles = new SlowFiles(config.rootDir);
    this.#projects = config.projects;
    this.#suite = suite;
  }

  public onTestBegin(test: TestCase, result: TestResult): void {
    this.#lastTests.set(result.workerIndex, test.titlePath().filter(Boolean).join(' › '));
  }

  public onError(error: TestError): void {
    const [message = ''] = (error.message ?? error.value ?? '').split('\n');
    const index = workerNamed(message);
    const last = index === undefined ? undefined : this.#lastTests.get(index);
    const told = last === undefined ? message : `${message} (its last test: ${last})`;
    this.#runErrors.push(told);
    if (last !== undefined) {
      console.log(styleText('red', `worker-${String(index)} last ran ${last}`));
    }
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const { file } = test.location;
    if (file !== this.#setupFile) {
      this.#slowFiles.add(test.titlePath()[1] ?? '', file, result);
    }
    for (const attachment of result.attachments) {
      const journey = attachedJson(attachment, JOURNEY_ATTACHMENT);
      if (isJourneyMeasure(journey)) {
        this.#journeys.push(journey);
      }
      const measured = attachedJson(attachment, STEPS_ATTACHMENT);
      if (isMeasured(measured)) {
        this.#record(measured);
      }
    }
    // An interrupted or skipped test has nothing of its own to explain.
    if (result.status === 'failed' || result.status === 'timedOut') {
      this.#printFailure(test, result);
    }
  }

  #record({ target, steps }: Measured): void {
    const byStep = this.#measured.get(target) ?? new Map<string, Map<string, number[]>>();
    this.#measured.set(target, byStep);
    for (const { name: step, metrics } of steps) {
      const byMetric = byStep.get(step) ?? new Map<string, number[]>();
      byStep.set(step, byMetric);
      for (const [id, value] of Object.entries(metrics)) {
        const values = byMetric.get(id) ?? [];
        values.push(value);
        byMetric.set(id, values);
      }
    }
  }

  #printFailure(test: TestCase, result: TestResult): void {
    const context = result.attachments
      .filter(({ name, body }) => name === FAILURE_ATTACHMENT && body !== undefined)
      .map(({ body }) => (body === undefined ? '' : body.toString('utf8')));
    const title = test.titlePath().join(' › ');
    const paths = failedPaths(result.steps);
    console.log(
      [styleText('red', `✘ ${title}`), ...paths, ...context, ...pageSnapshot(result)].join('\n'),
    );
    this.#summary.push(`- ✘ ${title}`, ...paths.map((path) => `  - ${path.trim()}`));
  }

  #tallies(): Map<string, ProjectTally> {
    const tallies = new Map<string, ProjectTally>(
      this.#projects.map(({ name, dependencies }) => [name, { dependencies, failed: 0, unrun: 0 }]),
    );
    for (const test of this.#suite === undefined ? [] : this.#suite.allTests()) {
      const project = test.parent.project();
      const name = project === undefined ? '' : project.name;
      const tally = tallies.get(name) ?? { dependencies: [], failed: 0, unrun: 0 };
      const failed = test.outcome() === 'unexpected' ? 1 : 0;
      const unrun = didNotRun(test) ? 1 : 0;
      tallies.set(name, {
        dependencies: tally.dependencies,
        failed: tally.failed + failed,
        unrun: tally.unrun + unrun,
      });
    }
    return tallies;
  }

  /** Names every project whose tests did not run, and why; such a run fails unless interrupted. */
  async #unrun(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    if (result.status === 'interrupted') {
      return undefined;
    }
    const lines = unrunReport(this.#tallies(), this.#runErrors);
    if (lines.length === 0) {
      return undefined;
    }
    // Written out before the runner goes on to exit with the failure.
    await new Promise<void>((resolve) => {
      process.stdout.write(styleText('red', `\n${lines.join('\n')}\n`), () => {
        resolve();
      });
    });
    return { status: 'failed' };
  }

  public async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    const slow = this.#slowFiles.report();
    if (slow.length > 0) {
      console.log(slow.join('\n'));
    }
    this.#printJourneys();
    if (this.#measured.size > 0) {
      this.#printSteps();
    }
    const file = process.env[STEP_SUMMARY];
    if (file !== undefined && file !== '' && this.#summary.length > 0) {
      appendFileSync(file, `${this.#summary.join('\n')}\n`);
    }
    return this.#unrun(result);
  }

  #printSteps(): void {
    console.log(
      `\nMeasured steps, median ± standard deviation over the projects that measured them; (%) is the share of Google's "good" budget used.`,
    );
    for (const [target, byStep] of [...this.#measured].toSorted(([one], [other]) =>
      one.localeCompare(other),
    )) {
      const rows = [...byStep]
        .toSorted(([one], [other]) => one.localeCompare(other))
        .map(([step, byMetric]) => rowOf(step, byMetric));
      const headings = ['Step', 'n', ...COLUMNS.map(({ label }) => label)];
      console.log([styleText('bold', target), ...table([headings, ...rows]), ''].join('\n'));
      this.#summary.push(
        `### Measured steps: ${target}`,
        '',
        ...markdownTable([headings, ...rows]),
        '',
      );
    }
  }
}
