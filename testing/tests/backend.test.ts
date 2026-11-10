import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executableOf } from '../src/stack/backend.ts';

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

await test('lines without an executable are never parsed', () => {
  const noise = Array.from({ length: 50_000 }, () => '{ not json, and no executable key');
  const messages = [...noise, artifact('backend', '/bin/backend')].join('\n');
  assert.equal(executableOf(messages, 'backend'), '/bin/backend');
});
