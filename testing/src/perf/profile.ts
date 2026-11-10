import type { Page } from '@playwright/test';

import { edgeIdOf, setNetwork } from '../edge-client.ts';
import type { Row } from '../matrix.ts';
import { CPU_SLOWDOWN, type CpuTier, type Network } from '../network.ts';
import { widenTestTurn } from '../stack/control.ts';

/** The conditions Google's "good" budgets are defined at, and Lighthouse's form factor. */
export interface Reference {
  readonly network: Network;
  readonly cpu: CpuTier;
  readonly formFactor: 'desktop' | 'mobile';
}

/** Desktop: unthrottled and wired. Mobile: Lighthouse's own slow 4G with a 4× slower CPU. */
const REFERENCES = {
  desktop: { network: 'wired', cpu: 'high', formFactor: 'desktop' },
  mobile: { network: '4g', cpu: 'low', formFactor: 'mobile' },
} as const satisfies Record<string, Reference>;

/** A gated row's reference: the low-CPU rows are the mobile reference, row 1 the desktop one. */
export const referenceOf = (row: Row): Reference | undefined => {
  if (!row.gated) {
    return undefined;
  }
  return row.cpu === 'low' ? REFERENCES.mobile : REFERENCES.desktop;
};

const throttle = async (page: Page, cpu: CpuTier): Promise<void> => {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN[cpu] });
  } finally {
    await session.detach();
  }
};

interface Conditions {
  readonly page: Page;
  readonly row: Row;
  readonly origin: string;
}

/** Runs a gated row's measured step at its reference network and CPU, then puts the row's back;
 *  its test holds every CPU slot from then on, so no other load enters a figure. */
export const underReference = async <Result>(
  { page, row, origin }: Conditions,
  step: () => Promise<Result>,
): Promise<Result> => {
  const reference = referenceOf(row);
  if (reference === undefined) {
    return step();
  }
  await widenTestTurn();
  const id = edgeIdOf(page.context());
  await setNetwork(origin, id, reference.network);
  await throttle(page, reference.cpu);
  try {
    return await step();
  } finally {
    await setNetwork(origin, id, row.network);
    await throttle(page, row.cpu);
  }
};
