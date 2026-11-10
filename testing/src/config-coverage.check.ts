import { expect, test } from '@playwright/test';

import { claimsIn, unclaimedKeys } from './config-coverage.ts';

const config = {
  limits: { max_open_notes: 4, share: { editors: 5, members: 20 } },
  sessions: { idle_minutes: 240 },
  infra: { memory_max: '1G' },
};

test('a key that no header and no reason claims is reported, and nothing else', () => {
  const claims = claimsIn('// Covers: limits.max_open_notes, sessions.idle_minutes\n');
  const sections = ['limits', 'sessions'];
  expect(unclaimedKeys({ config, sections, claims, elsewhere: {} })).toEqual([
    'limits.share.editors',
    'limits.share.members',
  ]);
  const elsewhere = { 'limits.share.editors': 'load tool', 'limits.share.members': 'Rust' };
  expect(unclaimedKeys({ config, sections, claims, elsewhere })).toEqual([]);
});

test('headers are read from line and block comments alike', () => {
  const source = '/**\n * Covers: limits.max_open_notes.\n */\n// Covers: sessions.idle_minutes\n';
  expect(claimsIn(source)).toEqual(['limits.max_open_notes', 'sessions.idle_minutes']);
});

test('a user-facing section missing from the file is itself unclaimed', () => {
  expect(unclaimedKeys({ config, sections: ['frontend'], claims: [], elsewhere: {} })).toEqual([
    'frontend',
  ]);
});
