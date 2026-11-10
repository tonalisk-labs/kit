// A repo's targets are named for the repo when it has one site, and for their folders when it has
// several, whether a site sits at the root or in a folder; a worktree's as its main checkout's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { discoverIn } from '../src/discover.ts';

/** A repo named `name` with an Astro config in each of `folders` ('.' for the root). */
const repoWith = (name: string, folders: readonly string[]): string => {
  const parent = mkdtempSync(path.join(tmpdir(), 'discover-'));
  const repo = path.join(parent, name);
  for (const folder of folders) {
    mkdirSync(path.join(repo, folder), { recursive: true });
    writeFileSync(path.join(repo, folder, 'astro.config.mjs'), '');
  }
  return repo;
};

const namesIn = (repo: string): string[] => {
  try {
    return discoverIn(repo).map(({ name }) => name);
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
};

await test('a site at the root is named for the repo', () => {
  assert.deepEqual(namesIn(repoWith('book.example', ['.'])), ['book.example']);
});

await test('one site in a folder is named for the repo', () => {
  assert.deepEqual(namesIn(repoWith('site.example', ['web'])), ['site.example']);
});

await test('several sites are named for the repo and their folders', () => {
  assert.deepEqual(namesIn(repoWith('app.example', ['web', 'docs'])), [
    'app.example/docs',
    'app.example/web',
  ]);
});

/** Git in `folder`, apart from the repo, hooks, signing and identity of whoever runs the test. */
const git = (folder: string, ...args: string[]): void => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  execFileSync(
    'git',
    [
      '-c',
      'user.name=kit',
      '-c',
      'user.email=kit@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: folder, env, stdio: 'ignore' },
  );
};

/** `repo` made a git checkout of what it holds, in one commit. */
const committed = (repo: string): string => {
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '--message', 'sites');
  return repo;
};

const names = (folder: string): string[] => discoverIn(folder).map(({ name }) => name);

await test('a worktree is named as the main checkout of its repo', () => {
  const repo = committed(repoWith('app.example', ['web', 'docs']));
  try {
    const worktree = path.join(path.dirname(repo), 'app-lane');
    git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
    assert.deepEqual(names(repo), ['app.example/docs', 'app.example/web']);
    assert.deepEqual(names(worktree), names(repo));
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
});

await test('a folder below the top of a checkout is named for itself', () => {
  const repo = committed(repoWith('outer.example', ['site']));
  try {
    assert.deepEqual(names(repo), ['outer.example']);
    assert.deepEqual(names(path.join(repo, 'site')), ['site']);
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
});
