import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildArguments, buildBackendWith, executableOf } from '../src/stack/backend.ts';

const artifact = (name: string, executable?: string): string =>
  JSON.stringify({ reason: 'compiler-artifact', target: { name }, executable });

await test("the crate's executable is read from Cargo's artifact lines only", () => {
  const messages = [
    'Compiling something',
    JSON.stringify({ reason: 'compiler-message', message: { rendered: '"executable"' } }),
    artifact('dependency'),
    artifact('other', '/target/release/other'),
    artifact('backend', '/target/release/backend'),
    JSON.stringify({ reason: 'build-finished', success: true }),
    '',
  ].join('\n');
  assert.equal(executableOf(messages, 'backend'), '/target/release/backend');
  assert.equal(executableOf(messages, 'missing'), undefined);
});

await test('a backend builds in release, with no features, unless told otherwise', () => {
  const json = '--message-format=json-render-diagnostics';
  assert.deepEqual(buildArguments('backend', {}), [
    'build',
    '--profile',
    'release',
    '--package',
    'backend',
    json,
  ]);
  assert.deepEqual(buildArguments('backend', { features: ['metrics', 'tls'] }), [
    'build',
    '--profile',
    'release',
    '--package',
    'backend',
    '--features',
    'metrics',
    '--features',
    'tls',
    json,
  ]);
  assert.deepEqual(buildArguments('backend', { profile: 'profiling' }), [
    'build',
    '--profile',
    'profiling',
    '--package',
    'backend',
    json,
  ]);
});

await test('a profile or feature Cargo would refuse is refused before anything runs', () => {
  const profiles = ['release; touch x', '$(id)', '`id`', 'a b', '', '--config=x', 'x/y', 'build'];
  for (const profile of [...profiles, 'BUILD-override', 'cargo-thing']) {
    assert.throws(() => buildArguments('backend', { profile }), /Cargo takes no profile named/u);
  }
  for (const feature of ['a;b', '$(id)', 'dep:x', 'serde/std', '', '-x', '.x', 'a b']) {
    assert.throws(
      () => buildArguments('backend', { features: [feature] }),
      /Cargo takes no feature named/u,
    );
  }
  for (const profile of ['dev', 'release', 'profiling', 'my_profile-2', 'Übung']) {
    assert.ok(buildArguments('backend', { profile }).includes(profile), profile);
  }
  for (const feature of ['test-clock', 'tls_1.3', '2fa', 'c++', 'große']) {
    assert.ok(buildArguments('backend', { features: [feature] }).includes(feature), feature);
  }
});

await test('a package Cargo would refuse is refused before anything runs', () => {
  for (const crate of ['-x', '--config=x', 'a b', 'x/y', '2fa', '', 'a;b', '$(id)']) {
    assert.throws(() => buildArguments(crate, {}), /Cargo takes no package named/u);
  }
  for (const crate of ['backend', 'astronotes-server', 'kit_server', '_private', 'Übung']) {
    assert.ok(buildArguments(crate, {}).includes(crate), crate);
  }
});

/** A `cargo` that records its arguments and reports one built binary, first on PATH while
 *  `body` runs; this file's own process is the only one that sees it. */
const withCargo = async (body: (recorded: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kit-cargo-'));
  const recorded = path.join(dir, 'arguments');
  const artifactLine = artifact('backend', '/target/profiling/backend');
  await writeFile(
    path.join(dir, 'cargo'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nprintf '%s\\n' '${artifactLine}'\n`,
    { mode: 0o755 },
  );
  const before = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${before ?? ''}`;
  try {
    await body(recorded);
  } finally {
    process.env['PATH'] = before;
    await rm(dir, { recursive: true });
  }
};

await test('a name holding shell syntax runs nothing, and a valid one builds as before', async () => {
  await withCargo(async (recorded) => {
    const { signal } = new AbortController();
    const refused = ['release; touch x', '$(id)'].map(async (profile) =>
      assert.rejects(
        buildBackendWith('backend', signal, { profile }),
        /Cargo takes no profile named/u,
      ),
    );
    await Promise.all(refused);
    await assert.rejects(access(recorded), { code: 'ENOENT' });
    const built = buildBackendWith('backend', signal, {
      profile: 'profiling',
      features: ['test-clock'],
    });
    assert.equal(await built, '/target/profiling/backend');
    const told = await readFile(recorded, 'utf8');
    assert.deepEqual(told.trimEnd().split('\n'), [
      'build',
      '--profile',
      'profiling',
      '--package',
      'backend',
      '--features',
      'test-clock',
      '--message-format=json-render-diagnostics',
    ]);
  });
});

await test('lines without an executable are never parsed', () => {
  const noise = Array.from({ length: 50_000 }, () => '{ not json, and no executable key');
  const messages = [...noise, artifact('backend', '/bin/backend')].join('\n');
  assert.equal(executableOf(messages, 'backend'), '/bin/backend');
});
