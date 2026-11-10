import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { datedBy, lastChanged } from '../sitemap.ts';

const DATE = '2026-09-30T08:15:00+01:00';
const COMMITTED = '2026-10-04T19:40:00+01:00';

/** A repository with one page written at DATE and committed later, and one file never committed. */
const repository = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'sitemap-dates-'));
  // The commit's date and author are the test's alone, whatever the machine's settings.
  const env = Object.fromEntries([
    ['PATH', process.env['PATH'] ?? ''],
    ['HOME', root],
    ['GIT_CONFIG_NOSYSTEM', '1'],
    ['GIT_AUTHOR_DATE', DATE],
    ['GIT_COMMITTER_DATE', COMMITTED],
    ['GIT_AUTHOR_NAME', 'Test'],
    ['GIT_AUTHOR_EMAIL', 'test@example.com'],
    ['GIT_COMMITTER_NAME', 'Test'],
    ['GIT_COMMITTER_EMAIL', 'test@example.com'],
  ]);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  };
  git('init', '--quiet');
  writeFileSync(path.join(root, 'page.md'), 'A page.\n');
  git('add', 'page.md');
  git('commit', '--quiet', '-m', 'A page');
  writeFileSync(path.join(root, 'draft.md'), 'Not yet.\n');
  return root;
};

await test('a page is dated by when its sources were written, and a page git cannot date by nothing', () => {
  const root = repository();
  try {
    assert.equal(lastChanged(root, ['page.md']), DATE);
    assert.equal(lastChanged(root, ['draft.md']), undefined);
    assert.equal(lastChanged(root, []), undefined);
    const serialize = datedBy(root, (pathname) => (pathname === '/' ? ['page.md'] : ['draft.md']));
    assert.deepEqual(serialize({ url: 'https://www.example.com/' }), {
      url: 'https://www.example.com/',
      lastmod: DATE,
    });
    assert.deepEqual(serialize({ url: 'https://www.example.com/draft/' }), {
      url: 'https://www.example.com/draft/',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('outside a repository the build stops, rather than leave every page undated', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sitemap-none-'));
  try {
    assert.throws(() => lastChanged(root, ['page.md']), /not a git repository/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
