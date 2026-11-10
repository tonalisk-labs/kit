#!/usr/bin/env node
// Holds each Cargo manifest named (the workspace's own by default) to kit's lint table,
// rules/rust-lints.toml, and the repo's clippy.toml to kit's rules/clippy.toml. A lint left out or
// set otherwise fails; a repo may add denials and disallowed paths of its own, and relaxes one of
// kit's lints only by naming it: kit-rust-lints --relaxing unsafe_code core/ffi/Cargo.toml. One
// crate may hold unsafe code under the workspace's tables: kit-rust-lints --unsafe-in core/ffi.
// With --elite, the repo's clippy.toml holds kit's rules/clippy-elite.toml thresholds too.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parse } from 'smol-toml';

/** The folder kit is in, found the same from its sources, its build and an installed copy. */
const KIT = path.dirname(createRequire(import.meta.url).resolve('@tonalisk-labs/kit/package.json'));
const GROUPS = ['rust', 'clippy'] as const;
const DISALLOWED = ['disallowed-methods', 'disallowed-types'] as const;
/** The levels a repo may add a lint at: an addition only ever tightens. */
const TIGHTENING = new Set(['deny', 'forbid']);

const member = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const entries = (value: unknown): [string, unknown][] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : [];

/** A lint's setting as one line: its level, or its table with the keys in order. */
const shown = (setting: unknown): string =>
  typeof setting === 'object' && setting !== null
    ? JSON.stringify(
        Object.fromEntries(entries(setting).toSorted(([one], [other]) => (one < other ? -1 : 1))),
      )
    : JSON.stringify(setting);

const levelOf = (setting: unknown): unknown =>
  typeof setting === 'string' ? setting : member(setting, 'level');

/** A manifest as read, under the name findings give it, and the lints of kit's it may relax. */
export interface Manifest {
  readonly name: string;
  readonly manifest: unknown;
  readonly relaxing?: ReadonlySet<string>;
}

/** What keeps a manifest's lint tables from kit's: each line a lint left out, changed or loosened.
 *  A crate that takes its workspace's tables has none of its own to hold. */
export const lintFindings = (
  canonical: unknown,
  { name, manifest, relaxing = new Set() }: Manifest,
): string[] => {
  const workspace = member(member(manifest, 'workspace'), 'lints');
  const own = member(manifest, 'lints');
  if (workspace === undefined && member(own, 'workspace') === true) {
    return [];
  }
  const [prefix, lints] = workspace === undefined ? ['lints', own] : ['workspace.lints', workspace];
  if (lints === undefined) {
    return [`${name}: no [${prefix}] tables; copy them from kit's rules/rust-lints.toml`];
  }
  return GROUPS.flatMap((group) => {
    const table = `${name}: [${prefix}.${group}]`;
    const wanted = new Map(entries(member(canonical, group)));
    const found = new Map(entries(member(lints, group)));
    const drift: string[] = [];
    for (const [lint, setting] of wanted) {
      const set = found.get(lint);
      if (!relaxing.has(lint) && shown(set) !== shown(setting)) {
        drift.push(
          set === undefined
            ? `${table} lacks ${lint} = ${shown(setting)}`
            : `${table} sets ${lint} to ${shown(set)}, where kit sets ${shown(setting)}`,
        );
      }
    }
    for (const [lint, set] of found) {
      if (!wanted.has(lint) && !relaxing.has(lint) && !TIGHTENING.has(String(levelOf(set)))) {
        drift.push(
          `${table} adds ${lint} = ${shown(set)}; a repo adds only denials, or names what it relaxes`,
        );
      }
    }
    return drift;
  });
};

/** Each of kit's disallowed paths the repo's clippy.toml leaves out. */
export const clippyFindings = (canonical: unknown, name: string, config: unknown): string[] =>
  DISALLOWED.flatMap((key) => {
    const paths = (value: unknown): Set<unknown> =>
      new Set((Array.isArray(value) ? value : []).map((entry: unknown) => member(entry, 'path')));
    const held = paths(member(config, key));
    return [...paths(member(canonical, key))].flatMap((wanted) =>
      held.has(wanted) ? [] : [`${name}: ${key} lacks ${String(wanted)}`],
    );
  });

/** Each of kit's elite thresholds the repo's clippy.toml leaves out or sets looser. */
export const eliteFindings = (elite: unknown, name: string, config: unknown): string[] =>
  entries(elite).flatMap(([key, limit]) => {
    const set = member(config, key);
    if (typeof set === 'number' && typeof limit === 'number' && set <= limit) {
      return [];
    }
    return [`${name}: ${key} is ${String(set)}, where kit's elite limit is ${String(limit)}`];
  });

const read = (file: string): unknown => parse(readFileSync(file, 'utf8'));

/** Kit's table as a workspace with one crate of unsafe code holds it: denied rather than
 *  forbidden, since a forbid lets no crate root expect it. */
export const withUnsafeCrate = (canonical: unknown): unknown =>
  Object.fromEntries(
    GROUPS.map((group) => {
      const table = new Map(entries(member(canonical, group)));
      if (group === 'rust') {
        table.set('unsafe_code', 'deny');
      }
      return [group, Object.fromEntries(table)];
    }),
  );

/** The crate named to hold unsafe code: its folder, its manifest, and its root's text. */
export interface UnsafeCrate {
  readonly folder: string;
  readonly manifest: unknown;
  readonly root: string;
}

const EXPECTED = /^#!\[expect\(\s*unsafe_code\s*,\s*reason\s*=/mu;
const LET_IN = /\b(?:allow|expect)\(\s*unsafe_code\b/u;

/** What keeps unsafe code to its one crate: it takes the workspace's tables, its root expects
 *  unsafe code with a reason, and no other member's source lets it in, so the rest stay forbidden. */
export const unsafeFindings = (
  crate: UnsafeCrate,
  others: ReadonlyMap<string, string>,
): string[] => [
  ...(member(member(crate.manifest, 'lints'), 'workspace') === true
    ? []
    : [`${crate.folder}/Cargo.toml: [lints] takes the workspace's, with workspace = true`]),
  ...(EXPECTED.test(crate.root)
    ? []
    : [`${crate.folder}/src/lib.rs: #![expect(unsafe_code, reason = "...")] opens the crate`]),
  ...[...others].flatMap(([file, text]) =>
    LET_IN.test(text) ? [`${file} lets unsafe code in, outside ${crate.folder}`] : [],
  ),
];

/** The member a file belongs to: the deepest whose folder holds it. */
const ownerOf = (members: readonly string[], file: string): string => {
  const holding = members.filter((folder) => file.startsWith(`${folder}/`));
  return holding.toSorted((one, other) => other.length - one.length)[0] ?? '';
};

/** Every tracked Rust file of the workspace's other members, with its text. */
const othersOf = (workspace: unknown, folder: string): Map<string, string> => {
  const listed = member(member(workspace, 'workspace'), 'members');
  const members = (Array.isArray(listed) ? listed : []).map(String);
  const files = execFileSync('git', ['ls-files', '-z', '*.rs'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && ownerOf(members, file) !== '');
  return new Map(
    files
      .filter((file) => ownerOf(members, file) !== folder)
      .map((file) => [file, readFileSync(file, 'utf8')]),
  );
};

/** The findings for the crate named to hold unsafe code, if one is. */
const unsafeCrateFindings = (folder: string | undefined): string[] =>
  folder === undefined
    ? []
    : unsafeFindings(
        {
          folder,
          manifest: read(path.join(folder, 'Cargo.toml')),
          root: readFileSync(path.join(folder, 'src', 'lib.rs'), 'utf8'),
        },
        othersOf(read('Cargo.toml'), folder),
      );

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: {
      relaxing: { type: 'string', multiple: true, default: [] },
      'unsafe-in': { type: 'string' },
      elite: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const manifests = positionals.length === 0 ? ['Cargo.toml'] : positionals;
  const kit = read(path.join(KIT, 'rules', 'rust-lints.toml'));
  const unsafeIn = values['unsafe-in'];
  const lints = unsafeIn === undefined ? kit : withUnsafeCrate(kit);
  const relaxing = new Set(values.relaxing);
  const config = 'clippy.toml';
  const findings = [
    ...manifests.flatMap((name) => lintFindings(lints, { name, manifest: read(name), relaxing })),
    ...(existsSync(config)
      ? clippyFindings(read(path.join(KIT, 'rules', 'clippy.toml')), config, read(config))
      : [`no ${config}; copy it from kit's rules/clippy.toml`]),
    ...unsafeCrateFindings(unsafeIn),
    ...(values.elite && existsSync(config)
      ? eliteFindings(read(path.join(KIT, 'rules', 'clippy-elite.toml')), config, read(config))
      : []),
  ];
  for (const finding of findings) {
    console.error(finding);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`kit-rust-lints: ${manifests.join(', ')} and ${config} hold kit's rules`);
  }
}
