import { type BrowserContextOptions, devices, type PlaywrightTestOptions } from '@playwright/test';

import type { CpuTier, Network } from './network.ts';

type Engine = 'chromium' | 'firefox' | 'webkit';
type Form = 'desktop' | 'laptop' | 'tablet' | 'phone';
type Orientation = 'portrait' | 'landscape';

/** A row of the test matrix: its engine, device form and orientation, CPU tier and network. */
export interface Row {
  /** The row's number in the table, and the project's `NN`. */
  readonly number: number;
  readonly engine: Engine;
  readonly form: Form;
  readonly orientation: Orientation;
  readonly cpu: CpuTier;
  readonly network: Network;
  /** Google's "good" budgets gate here: the desktop and the low-end mobile references. */
  readonly gated: boolean;
  /** A screen class of the repo's own (devices.ts), emulated as it says; the table's rows have
   *  none. */
  readonly device?: { readonly id: string; readonly options: DeviceOptions };
}

type Cells = readonly [Engine, Form, Orientation, CpuTier, Network, boolean];

/** A pairwise (all-pairs) table: every pair of values appears in some row. */
const TABLE: readonly Cells[] = [
  ['chromium', 'desktop', 'landscape', 'high', 'wired', true],
  ['firefox', 'desktop', 'landscape', 'high', '4g', false],
  ['webkit', 'desktop', 'landscape', 'high', '3g', false],
  ['chromium', 'desktop', 'landscape', 'low', 'lossy', true],
  ['firefox', 'laptop', 'landscape', 'high', 'wired', false],
  ['webkit', 'laptop', 'landscape', 'high', '4g', false],
  ['chromium', 'laptop', 'landscape', 'low', '3g', true],
  ['webkit', 'laptop', 'landscape', 'high', 'lossy', false],
  ['webkit', 'tablet', 'portrait', 'high', 'wired', false],
  ['chromium', 'tablet', 'landscape', 'low', '4g', true],
  ['firefox', 'tablet', 'portrait', 'high', '3g', false],
  ['chromium', 'tablet', 'portrait', 'high', 'lossy', false],
  ['chromium', 'phone', 'portrait', 'low', 'wired', true],
  ['firefox', 'phone', 'portrait', 'high', '4g', false],
  ['webkit', 'phone', 'landscape', 'high', '3g', false],
  ['firefox', 'phone', 'landscape', 'high', 'lossy', false],
];

export const ROWS: readonly Row[] = TABLE.map(
  ([engine, form, orientation, cpu, network, gated], index) => ({
    number: index + 1,
    engine,
    form,
    orientation,
    cpu,
    network,
    gated,
  }),
);

/** Rows per tier: smoke is row 1; dev spans rows 1-3, one per engine, to fill a workstation;
 *  measured is a desktop row and a phone row, both Chromium so both count CPU time. */
const TIERS: Readonly<Record<string, readonly Row[]>> = {
  smoke: ROWS.slice(0, 1),
  dev: ROWS.slice(0, 3),
  measured: [ROWS[0], ROWS[12]].filter((row) => row !== undefined),
};

/** The rows of `tier`: `devices` is the repo's screen classes alone, the full matrix the table's
 *  rows and then the classes'. */
export const tierRows = (
  tier: string | undefined,
  classes: readonly Row[] = [],
): readonly Row[] => {
  if (tier === 'devices') {
    return classes;
  }
  return (tier === undefined ? undefined : TIERS[tier]) ?? [...ROWS, ...classes];
};

/** A row's name: a screen class's names its engine and the class, the table's every cell. */
export const rowName = (row: Row): string =>
  [
    String(row.number).padStart(2, '0'),
    row.engine,
    ...(row.device === undefined
      ? [row.form, row.orientation, row.cpu, row.network]
      : [row.device.id]),
  ].join('-');

/** Playwright's descriptor per engine and form; Firefox borrows a handheld's viewport only. */
const DESCRIPTORS: Readonly<Record<Engine, Readonly<Record<Form, string>>>> = {
  chromium: {
    desktop: 'Desktop Chrome',
    laptop: 'Desktop Chrome HiDPI',
    tablet: 'Galaxy Tab S9',
    phone: 'Pixel 7',
  },
  firefox: {
    desktop: 'Desktop Firefox',
    laptop: 'Desktop Firefox HiDPI',
    tablet: 'Galaxy Tab S9',
    phone: 'Pixel 7',
  },
  webkit: {
    desktop: 'Desktop Safari',
    laptop: 'Desktop Safari',
    tablet: 'iPad Pro 11',
    phone: 'iPhone 15',
  },
};

/** A desktop monitor; a laptop keeps its descriptor's HiDPI 1280 × 720. */
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

export type DeviceOptions = Pick<
  PlaywrightTestOptions,
  'viewport' | 'userAgent' | 'deviceScaleFactor' | 'isMobile' | 'hasTouch'
> & { readonly screen?: BrowserContextOptions['screen'] };

const descriptor = (name: string): DeviceOptions => {
  const device = devices[name];
  if (device === undefined) {
    throw new Error(`Playwright has no device named ${name}`);
  }
  return {
    viewport: device.viewport,
    userAgent: device.userAgent,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  };
};

const resized = (
  device: DeviceOptions,
  viewport: DeviceOptions['viewport'],
  deviceScaleFactor = device.deviceScaleFactor,
): DeviceOptions => ({
  viewport,
  userAgent: device.userAgent,
  deviceScaleFactor,
  isMobile: device.isMobile,
  hasTouch: device.hasTouch,
});

/** The browser and device a row runs on. Firefox cannot emulate a mobile viewport, so a handheld
 *  row borrows its size on the desktop descriptor, with touch on as the handheld has it. */
export const deviceOf = (row: Row): DeviceOptions => {
  if (row.device !== undefined) {
    return row.device.options;
  }
  const name = DESCRIPTORS[row.engine][row.form];
  const handheld = row.form === 'tablet' || row.form === 'phone';
  const turned = handheld && row.orientation === 'landscape' ? `${name} landscape` : name;
  const device = descriptor(turned);
  if (row.engine === 'firefox' && handheld) {
    return Object.assign(resized(descriptor('Desktop Firefox'), device.viewport), {
      hasTouch: true,
    });
  }
  return row.form === 'desktop' ? resized(device, DESKTOP_VIEWPORT, 1) : device;
};
