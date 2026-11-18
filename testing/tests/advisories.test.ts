// Kit's own audit (rules/audit.ts): every advisory npm reports is let pass by its ID in audit.toml,
// until a day at most 90 days off, or fails; an exception npm no longer reports fails too; and
// osv-scanner reads the same exceptions under the template's config.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'smol-toml';

import {
  type Exception,
  exceptionsOf,
  findingsOf,
  osvConfig,
  problemsOf,
} from '../../rules/audit.ts';

const KIT = path.resolve(import.meta.dirname, '../..');
const ID = 'GHSA-fc5q-39xc-vjpf';
const OTHER = 'GHSA-gcqx-w48m-w2h4';

/** The report npm audit writes of an advisory: on its package, and only by name on dependents. */
const REPORT = {
  vulnerabilities: {
    picomatch: {
      via: [{ url: `https://github.com/advisories/${ID}`, name: 'picomatch', severity: 'high' }],
    },
    anymatch: { via: ['picomatch'] },
    tinyglobby: {
      via: ['picomatch', { url: `https://github.com/advisories/${ID}`, name: 'picomatch' }],
    },
  },
};

const standing: Exception = { id: ID, reason: 'a tool’s alone', until: '2027-02-15' };

/** The standing exception with `change` made to it. */
const changed = (change: Partial<Exception>): Exception =>
  Object.assign(structuredClone(standing), change);

/** A parsed osv-scanner config's PackageOverrides tables. */
const overrides = (config: unknown): unknown =>
  typeof config === 'object' && config !== null ? Reflect.get(config, 'PackageOverrides') : [];

await test('an advisory is read once by its id, however many packages npm names it on', () => {
  assert.deepEqual(findingsOf(REPORT), [{ id: ID, name: 'picomatch', severity: 'high' }]);
  assert.deepEqual(findingsOf({}), []);
});

await test('an advisory npm reports fails with no exception, and passes with one until its day', () => {
  const found = findingsOf(REPORT);
  assert.deepEqual(problemsOf(found, [], '2026-11-18'), [
    `${ID} (high, in picomatch) has no exception: fix it, or record in audit.toml why it can’t reach anyone`,
  ]);
  assert.deepEqual(problemsOf(found, [standing], '2026-11-18'), []);
  assert.deepEqual(problemsOf(found, [standing], '2027-02-15'), [], 'its own day still stands');
  assert.deepEqual(problemsOf(found, [standing], '2027-02-16'), [
    `${ID} was due to be looked at again by 2027-02-15`,
  ]);
});

await test('an exception more than 90 days off, without a day, reason or GHSA id, is refused', () => {
  const found = findingsOf(REPORT);
  assert.deepEqual(problemsOf(found, [standing], '2026-11-16'), [
    `${ID} lets it pass until 2027-02-15, more than 90 days off`,
  ]);
  assert.deepEqual(problemsOf(found, [changed({ until: '', reason: '' })], '2026-11-18'), [
    `${ID} gives no reason it can’t reach anyone`,
    `${ID} has no effectiveUntil day, YYYY-MM-DD`,
  ]);
  assert.deepEqual(problemsOf([], [changed({ id: 'CVE-2026-1' })], '2026-11-18'), [
    'CVE-2026-1 names no GHSA advisory',
  ]);
});

await test('an exception for an advisory npm no longer reports fails, so it goes', () => {
  assert.deepEqual(problemsOf([], [changed({ id: OTHER })], '2026-11-18'), [
    `${OTHER} is no longer reported: remove its exception`,
  ]);
});

await test("kit's own exceptions stand, and osv-scanner reads them under the template's config", () => {
  const record = readFileSync(path.join(KIT, 'audit.toml'), 'utf8');
  const template = readFileSync(path.join(KIT, 'template', 'osv-scanner.toml'), 'utf8');
  const exceptions = exceptionsOf(parse(record));
  assert.deepEqual(
    exceptions.map(({ id, until }) => [id, until]),
    [[ID, '2027-02-15']],
  );
  assert.deepEqual(problemsOf(findingsOf(REPORT), exceptions, '2026-11-18'), []);
  const merged = parse(osvConfig(template, record));
  assert.deepEqual(overrides(merged), overrides(parse(template)));
  assert.deepEqual(exceptionsOf(merged), exceptions);
});
