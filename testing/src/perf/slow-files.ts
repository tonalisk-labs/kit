import path from 'node:path';
import { styleText } from 'node:util';

import type { TestResult } from '@playwright/test/reporter';

/** Playwright's defaults: a file is slow past 5 minutes, and the 5 slowest are named. */
const THRESHOLD_MS = 5 * 60_000;
const SHOWN = 5;

interface FileTime {
  duration: number;
  readonly workers: Set<number>;
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)}m`;

/** Playwright's slow-file report, kept by the reporter: each file's time under its project, and
 *  the files one worker ran past the threshold, slowest first. */
export class SlowFiles {
  readonly #root: string;

  readonly #times = new Map<string, FileTime>();

  /** Files are named from `root`, the config's, as Playwright names them. */
  public constructor(root: string) {
    this.#root = root;
  }

  public add(
    project: string,
    file: string,
    result: Pick<TestResult, 'duration' | 'workerIndex'>,
  ): void {
    const key = `[${project}] › ${path.relative(this.#root, file)}`;
    const time = this.#times.get(key) ?? { duration: 0, workers: new Set<number>() };
    time.duration += result.duration;
    time.workers.add(result.workerIndex);
    this.#times.set(key, time);
  }

  public report(): string[] {
    const slow = [...this.#times]
      .filter(([, { duration, workers }]) => workers.size === 1 && duration > THRESHOLD_MS)
      .toSorted(([, one], [, other]) => other.duration - one.duration)
      .slice(0, SHOWN);
    if (slow.length === 0) {
      return [];
    }
    return [
      ...slow.map(
        ([key, { duration }]) =>
          `${styleText('yellow', '  Slow test file: ')}${key}${styleText('yellow', ` (${minutes(duration)})`)}`,
      ),
      styleText(
        'yellow',
        '  Consider running tests from slow files in parallel. See: https://playwright.dev/docs/test-parallel',
      ),
    ];
  }
}
