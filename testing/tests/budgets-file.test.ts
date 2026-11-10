// A repo may name its budgets file, such as spec/budgets.json, in place of perf-budgets.json: its
// `sizes` and `journeys` are read as that file's are, its other sections left to their readers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BUDGETS_ENV, budgetsFile, journeyBudget, sizeBudget } from '../src/perf/budgets.ts';

const step = { counted: { requests: 3 }, timed: { '1': { cpu: 40 } } };
const SPEC = {
  web: { 'notes.append.cpu': { limit: { fixed: 2 } } },
  sizes: { web: { eager: 120_000 } },
  journeys: { web: { 'opens a note': step }, known: [] },
};

await test('the budgets file a repo names is read for its sizes and journeys alone', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kit-budgets-'));
  try {
    const file = path.join(folder, 'budgets.json');
    writeFileSync(file, JSON.stringify(SPEC));
    process.env[BUDGETS_ENV] = file;
    assert.equal(budgetsFile(), file);
    assert.equal(sizeBudget('web')['eager'], 120_000);
    assert.deepEqual(journeyBudget('web', 'opens a note'), step);
    assert.equal(journeyBudget('web', 'saves a note'), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
