import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { devices } from '@playwright/test';

import type { DeviceOptions, Row } from './matrix.ts';

/** A repo's screen classes, in `spec/devices.json` if it has one: each class's `id`, `platform`
 *  (`iphone`, `ipad` or `mac`) and `playwright` emulation; the rest of the file is the repo's. */
const DEVICES_FILE = path.join('spec', 'devices.json');

type Engine = Row['engine'];

const ENGINES: readonly Engine[] = ['chromium', 'firefox', 'webkit'];

const FORMS: Readonly<Record<string, Row['form']>> = {
  iphone: 'phone',
  ipad: 'tablet',
  mac: 'laptop',
};

/** Each engine's own agent, for a class with none of its own: a MacBook's browsers. */
const AGENTS: Readonly<Record<Engine, string>> = {
  chromium: 'Desktop Chrome HiDPI',
  firefox: 'Desktop Firefox HiDPI',
  webkit: 'Desktop Safari',
};

const refuse = (at: string, what: string): never => {
  throw new Error(`${DEVICES_FILE}: ${at} ${what}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objectAt = (value: unknown, at: string): Record<string, unknown> =>
  isRecord(value) ? value : refuse(at, 'is no object');

const numberAt = (value: unknown, at: string): number =>
  typeof value === 'number' && value > 0 ? value : refuse(at, 'is no positive number');

const flagAt = (value: unknown, at: string): boolean =>
  typeof value === 'boolean' ? value : refuse(at, 'is neither true nor false');

const sizeAt = (value: unknown, at: string): { width: number; height: number } => {
  const size = objectAt(value, at);
  return {
    width: numberAt(size['width'], `${at}.width`),
    height: numberAt(size['height'], `${at}.height`),
  };
};

const userAgentOf = (engine: Engine, own: unknown, at: string): string => {
  if (own !== undefined) {
    return typeof own === 'string' && own !== '' ? own : refuse(at, 'is no text');
  }
  const device = devices[AGENTS[engine]];
  return device === undefined
    ? refuse(at, `is unset, and Playwright has no ${AGENTS[engine]}`)
    : device.userAgent;
};

/** The engine a row names, refused where it cannot emulate the class's viewport. */
const engineAt = (name: unknown, at: string, isMobile: boolean): Engine => {
  const engine =
    ENGINES.find((one) => one === name) ??
    refuse(`${at}.playwright.engines`, `names ${String(name)}`);
  if (engine === 'firefox' && isMobile) {
    // Firefox has no mobile viewport to emulate, and Playwright refuses to launch it with one.
    return refuse(`${at}.playwright`, 'is mobile, which Firefox cannot emulate');
  }
  return engine;
};

/** A class's rows, one per engine, numbered from `first`. */
const rowsOfClass = (value: unknown, index: number, first: number): Row[] => {
  const at = `classes[${String(index)}]`;
  const entry = objectAt(value, at);
  const { id } = entry;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    return refuse(`${at}.id`, 'is no lowercase name of letters, digits and hyphens');
  }
  const form =
    FORMS[String(entry['platform'])] ?? refuse(`${at}.platform`, 'is none of iphone, ipad, mac');
  const emulation = objectAt(entry['playwright'], `${at}.playwright`);
  const engines = Array.isArray(emulation['engines']) ? emulation['engines'] : [];
  if (engines.length === 0) {
    return refuse(`${at}.playwright.engines`, 'names no engine');
  }
  const isMobile = flagAt(emulation['isMobile'], `${at}.playwright.isMobile`);
  return engines.map((name: unknown, offset): Row => {
    const engine = engineAt(name, at, isMobile);
    const options: DeviceOptions = {
      viewport: sizeAt(emulation['viewport'], `${at}.playwright.viewport`),
      screen: sizeAt(emulation['screen'], `${at}.playwright.screen`),
      userAgent: userAgentOf(engine, emulation['userAgent'], `${at}.playwright.userAgent`),
      deviceScaleFactor: numberAt(
        emulation['deviceScaleFactor'],
        `${at}.playwright.deviceScaleFactor`,
      ),
      isMobile,
      hasTouch: flagAt(emulation['hasTouch'], `${at}.playwright.hasTouch`),
    };
    return {
      number: first + offset,
      engine,
      form,
      orientation: form === 'laptop' ? 'landscape' : 'portrait',
      cpu: 'high',
      network: 'wired',
      gated: false,
      device: { id, options },
    };
  });
};

/** The rows of `repo`'s screen classes, numbered from `first`; none when it has no devices file. */
export const deviceRowsIn = (repo: string, first: number): Row[] => {
  const file = path.join(repo, DEVICES_FILE);
  if (!existsSync(file)) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const { classes } = objectAt(parsed, 'the file');
  if (!Array.isArray(classes)) {
    return refuse('classes', 'is no list');
  }
  const rows: Row[] = [];
  for (const [index, entry] of classes.entries()) {
    rows.push(...rowsOfClass(entry, index, first + rows.length));
  }
  return rows;
};
