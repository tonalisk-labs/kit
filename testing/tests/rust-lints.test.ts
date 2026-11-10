// A manifest holds kit's lint table whole: a lint left out, set otherwise or loosened is named, an
// added denial isn't, and a crate relaxes one of kit's lints only by naming it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'smol-toml';

import {
  clippyFindings,
  eliteFindings,
  lintFindings,
  unsafeFindings,
  withUnsafeCrate,
} from '../../rules/rust-lints.ts';

const read = (file: string): unknown =>
  parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const canonical = read('rules/rust-lints.toml');

/** One of kit's tables as entries, each lint changed, added or left out as `changes` says. */
const kitTable = (group: string, changes: Record<string, unknown> = {}): object => {
  const table: unknown = typeof canonical === 'object' ? Reflect.get(canonical ?? {}, group) : {};
  const lints = new Map(typeof table === 'object' ? Object.entries(table ?? {}) : []);
  for (const [lint, setting] of Object.entries(changes)) {
    if (setting === undefined) {
      lints.delete(lint);
    } else {
      lints.set(lint, setting);
    }
  }
  return Object.fromEntries(lints);
};

const workspace = (rust: object, clippy: object): unknown => ({
  workspace: { lints: { rust, clippy } },
});

await test("kit's own manifest and template hold the table, as a copy does", () => {
  for (const name of ['Cargo.toml', 'template/Cargo.toml.jinja']) {
    assert.deepEqual(lintFindings(canonical, { name, manifest: read(name) }), []);
  }
  const copy = workspace(kitTable('rust'), kitTable('clippy'));
  assert.deepEqual(lintFindings(canonical, { name: 'Cargo.toml', manifest: copy }), []);
});

await test('a lint left out, set otherwise or loosened is named, and an added denial is not', () => {
  const drifted = workspace(
    kitTable('rust', { unsafe_code: 'deny', missing_docs: { level: 'deny', priority: 1 } }),
    kitTable('clippy', {
      as_conversions: undefined,
      cast_lossless: 'allow',
      print_stdout: 'deny',
      shadow_unrelated: { level: 'forbid' },
    }),
  );
  assert.deepEqual(lintFindings(canonical, { name: 'Cargo.toml', manifest: drifted }), [
    'Cargo.toml: [workspace.lints.rust] sets unsafe_code to "deny", where kit sets "forbid"',
    'Cargo.toml: [workspace.lints.rust] sets missing_docs to {"level":"deny","priority":1}, where kit sets "deny"',
    'Cargo.toml: [workspace.lints.clippy] lacks as_conversions = "deny"',
    'Cargo.toml: [workspace.lints.clippy] adds cast_lossless = "allow"; a repo adds only denials, or names what it relaxes',
  ]);
});

await test('a crate with its own tables relaxes a lint only by naming it, and one that inherits has none', () => {
  const rust = kitTable('rust', { unsafe_code: 'allow', unsafe_op_in_unsafe_fn: 'deny' });
  const manifest = { lints: { rust, clippy: kitTable('clippy') } };
  const name = 'ffi/Cargo.toml';
  assert.deepEqual(lintFindings(canonical, { name, manifest }), [
    'ffi/Cargo.toml: [lints.rust] sets unsafe_code to "allow", where kit sets "forbid"',
  ]);
  const relaxing = new Set(['unsafe_code']);
  assert.deepEqual(lintFindings(canonical, { name, manifest, relaxing }), []);
  const member = { name: 'member/Cargo.toml', manifest: { lints: { workspace: true } } };
  assert.deepEqual(lintFindings(canonical, member), []);
  const bare = { name: 'bare/Cargo.toml', manifest: { package: {} } };
  assert.deepEqual(lintFindings(canonical, bare), [
    "bare/Cargo.toml: no [lints] tables; copy them from kit's rules/rust-lints.toml",
  ]);
});

await test("a repo's clippy.toml keeps every path kit disallows, and may add its own", () => {
  const clippy = read('rules/clippy.toml');
  assert.deepEqual(clippyFindings(clippy, 'clippy.toml', clippy), []);
  assert.deepEqual(clippyFindings(clippy, 'clippy.toml', read('clippy.toml')), []);
  const own = { 'disallowed-methods': [{ path: 'std::process::exit' }, { path: 'tokio::spawn' }] };
  assert.deepEqual(clippyFindings(clippy, 'clippy.toml', own), [
    'clippy.toml: disallowed-methods lacks sqlx::AssertSqlSafe',
    'clippy.toml: disallowed-types lacks sqlx::AssertSqlSafe',
  ]);
});

await test('a workspace with one crate of unsafe code denies it, where every other forbids it', () => {
  const denied = workspace(kitTable('rust', { unsafe_code: 'deny' }), kitTable('clippy'));
  const forbidden = workspace(kitTable('rust'), kitTable('clippy'));
  const withUnsafe = withUnsafeCrate(canonical);
  assert.deepEqual(lintFindings(withUnsafe, { name: 'Cargo.toml', manifest: denied }), []);
  assert.deepEqual(lintFindings(withUnsafe, { name: 'Cargo.toml', manifest: forbidden }), [
    'Cargo.toml: [workspace.lints.rust] sets unsafe_code to "forbid", where kit sets "deny"',
  ]);
  assert.equal(lintFindings(canonical, { name: 'Cargo.toml', manifest: denied }).length, 1);
});

await test('unsafe code stays in its crate: workspace lints, a reasoned expect, and nowhere else', () => {
  const crate = {
    folder: 'core/ffi',
    manifest: { lints: { workspace: true } },
    root: '//! The bridge.\n#![expect(unsafe_code, reason = "the C ABI")]\n',
  };
  const clean = new Map([['core/src/lib.rs', '#![doc = "core"]\n']]);
  assert.deepEqual(unsafeFindings(crate, clean), []);
  const leaky = new Map([['server/src/main.rs', '#[allow(unsafe_code)]\nfn f() {}\n']]);
  assert.deepEqual(
    unsafeFindings(
      { folder: crate.folder, manifest: { lints: { rust: {} } }, root: '#![allow(unsafe_code)]' },
      leaky,
    ),
    [
      "core/ffi/Cargo.toml: [lints] takes the workspace's, with workspace = true",
      'core/ffi/src/lib.rs: #![expect(unsafe_code, reason = "...")] opens the crate',
      'server/src/main.rs lets unsafe code in, outside core/ffi',
    ],
  );
});

await test("a repo's clippy.toml holds each elite threshold at kit's or tighter", () => {
  const elite = read('rules/clippy-elite.toml');
  const tight = { 'cognitive-complexity-threshold': 8, 'too-many-lines-threshold': 40 };
  assert.deepEqual(eliteFindings(elite, 'clippy.toml', tight), []);
  assert.deepEqual(eliteFindings(elite, 'clippy.toml', { 'too-many-lines-threshold': 60 }), [
    "clippy.toml: cognitive-complexity-threshold is undefined, where kit's elite limit is 10",
    "clippy.toml: too-many-lines-threshold is 60, where kit's elite limit is 40",
  ]);
});
