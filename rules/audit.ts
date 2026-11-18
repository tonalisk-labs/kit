#!/usr/bin/env node
// Kit's own audit, beside the template's: npm audit and osv-scanner may report only the advisories
// audit.toml lets pass, each by its ID until its day. An exception npm no longer reports fails, so
// none outlives its cause. Kit's alone, never shipped: its arguments are the osv-scanner command.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';

/** An advisory npm audit reports: its GHSA id, and the package and severity it names. */
export interface Finding {
  readonly id: string;
  readonly name: string;
  readonly severity: string;
}

/** An exception as osv-scanner's IgnoredVulns table holds it, its day as YYYY-MM-DD. */
export interface Exception {
  readonly id: string;
  readonly reason: string;
  readonly until: string;
}

const GHSA = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
/** The furthest an exception's day may be, so none is parked: the sites' own 90 days. */
const MOST_DAYS = 90;
const DAY_MS = 86_400_000;

const member = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const textOf = (value: unknown, key: string): string => {
  const found = member(value, key);
  return typeof found === 'string' ? found : '';
};

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** A day as TOML reads it unquoted, a Date, or as written. */
const dayOf = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return typeof value === 'string' ? value : '';
};

/** The advisories in `npm audit --json`'s report, once each, however many packages they reach. */
export const findingsOf = (report: unknown): Finding[] => {
  const found = new Map<string, Finding>();
  const vulnerabilities = member(report, 'vulnerabilities');
  const each =
    typeof vulnerabilities === 'object' && vulnerabilities !== null ? vulnerabilities : {};
  for (const vulnerability of Object.values(each)) {
    for (const via of listOf(member(vulnerability, 'via'))) {
      const id = textOf(via, 'url').split('/').at(-1) ?? '';
      if (GHSA.test(id) && !found.has(id)) {
        found.set(id, { id, name: textOf(via, 'name'), severity: textOf(via, 'severity') });
      }
    }
  }
  return [...found.values()];
};

/** The exceptions in audit.toml's IgnoredVulns tables. */
export const exceptionsOf = (record: unknown): Exception[] =>
  listOf(member(record, 'IgnoredVulns')).map((entry) => ({
    id: textOf(entry, 'id'),
    reason: textOf(entry, 'reason'),
    until: dayOf(member(entry, 'effectiveUntil')),
  }));

/** What is wrong with one exception on `today`, named by its advisory. */
const faultsOf = ({ id, reason, until }: Exception, today: string): string[] => {
  const named = id === '' ? 'an exception with no id' : id;
  const days = (Date.parse(until) - Date.parse(today)) / DAY_MS;
  const checks: [boolean, string][] = [
    [GHSA.test(id), 'names no GHSA advisory'],
    [reason !== '', 'gives no reason it can’t reach anyone'],
    [DAY.test(until), 'has no effectiveUntil day, YYYY-MM-DD'],
    [!DAY.test(until) || days >= 0, `was due to be looked at again by ${until}`],
    [!(days > MOST_DAYS), `lets it pass until ${until}, more than ${String(MOST_DAYS)} days off`],
  ];
  return checks.filter(([holds]) => !holds).map(([, problem]) => `${named} ${problem}`);
};

/** What is wrong on `today` (YYYY-MM-DD): an advisory with no exception, an exception out of shape
 *  or past its day, or one for an advisory npm no longer reports. */
export const problemsOf = (
  findings: readonly Finding[],
  exceptions: readonly Exception[],
  today: string,
): string[] => {
  const listed = new Set(exceptions.map(({ id }) => id));
  const reported = new Set(findings.map(({ id }) => id));
  return [
    ...exceptions.flatMap((exception) => faultsOf(exception, today)),
    ...findings
      .filter(({ id }) => !listed.has(id))
      .map(
        ({ id, name, severity }) =>
          `${id} (${severity}, in ${name}) has no exception: fix it, or record in audit.toml why it can’t reach anyone`,
      ),
    ...exceptions
      .filter(({ id }) => GHSA.test(id) && !reported.has(id))
      .map(({ id }) => `${id} is no longer reported: remove its exception`),
  ];
};

/** The template's osv-scanner config with the exceptions' tables after it, which TOML reads as one. */
export const osvConfig = (template: string, record: string): string => `${template}\n${record}`;

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..');
  const record = readFileSync(path.join(root, 'audit.toml'), 'utf8');
  // The report is read whatever npm audit exits with: it exits nonzero whenever it reports anything.
  const npm = spawnSync('npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const report: unknown = JSON.parse(npm.stdout);
  const findings = findingsOf(report);
  const today = new Date().toISOString().slice(0, 10);
  const problems =
    member(report, 'error') === undefined
      ? problemsOf(findings, exceptionsOf(parse(record)), today)
      : [`npm audit failed: ${JSON.stringify(member(report, 'error'))}`];
  for (const problem of problems) {
    console.error(`audit: ${problem}`);
  }
  if (problems.length === 0) {
    console.log(`audit: npm reports ${String(findings.length)}, each let pass by audit.toml`);
  }
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-audit-'));
  const config = path.join(folder, 'osv-scanner.toml');
  const template = readFileSync(path.join(root, 'template', 'osv-scanner.toml'), 'utf8');
  writeFileSync(config, osvConfig(template, record));
  const [command = '', ...given] = process.argv.slice(2);
  const osv = spawnSync(command, [...given, '--config', config], { cwd: root, stdio: 'inherit' });
  rmSync(folder, { recursive: true, force: true });
  process.exitCode = problems.length === 0 && osv.status === 0 ? 0 : 1;
}
