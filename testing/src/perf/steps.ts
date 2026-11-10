import type { TestInfo } from '@playwright/test';

import { isObject } from '../unknown.ts';

type Metrics = Readonly<Record<string, number>>;

/** One measured step of a test: its name and what it measured. */
export interface MeasuredStep {
  readonly name: string;
  readonly metrics: Metrics;
}

/** In-memory attachments the stdout reporter reads, as the suite writes no files. */
export const STEPS_ATTACHMENT = 'performance-steps';
export const FAILURE_ATTACHMENT = 'failure-context';
/** A measured journey step, for the per-journey table. */
export const JOURNEY_ATTACHMENT = 'journey-measure';

export interface Measured {
  readonly target: string;
  readonly steps: readonly MeasuredStep[];
}

/** Attaches a test's measured steps for the reporter's table of medians. */
export const attachSteps = async (testInfo: TestInfo, measured: Measured): Promise<void> => {
  await testInfo.attach(STEPS_ATTACHMENT, {
    body: JSON.stringify(measured),
    contentType: 'application/json',
  });
};

const isStep = (value: unknown): value is MeasuredStep =>
  isObject(value) &&
  typeof value['name'] === 'string' &&
  isObject(value['metrics']) &&
  Object.values(value['metrics']).every((metric) => typeof metric === 'number');

export const isMeasured = (value: unknown): value is Measured =>
  isObject(value) &&
  typeof value['target'] === 'string' &&
  Array.isArray(value['steps']) &&
  value['steps'].every((step) => isStep(step));
