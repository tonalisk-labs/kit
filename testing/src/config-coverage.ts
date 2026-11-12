import { readFileSync } from 'node:fs';

import { isObject } from './unknown.ts';

/** A header line of a spec naming the configuration keys it proves, comma separated. Its blanks
 *  are spaces and tabs only, so it never reaches the next line, and it reads in linear time. */
const COVERS = /^[ \t]*(?:\/\/|\*)[ \t]*Covers:[ \t]*(?<keys>\S.*)$/gmu;

/** The keys a spec's header claims, as dotted paths: `limits.max_open_notes`. */
export const claimsIn = (source: string): string[] =>
  [...source.matchAll(COVERS)].flatMap((match) =>
    (match.groups === undefined ? '' : (match.groups['keys'] ?? ''))
      .split(',')
      .map((key) => key.trim().replace(/\.$/u, ''))
      .filter((key) => key !== ''),
  );

/** The keys the headers of these spec files claim. */
export const claimsInFiles = (files: readonly string[]): string[] =>
  files.flatMap((file) => claimsIn(readFileSync(file, 'utf8')));

const leaves = (value: unknown, prefix: string): string[] =>
  isObject(value)
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, `${prefix}.${key}`))
    : [prefix];

interface Coverage {
  readonly config: unknown;
  /** The sections whose every key a journey must own, such as `limits`. */
  readonly sections: readonly string[];
  readonly claims: readonly string[];
  /** Keys proved elsewhere (Rust, the load tool), each with where and why. */
  readonly elsewhere: Readonly<Record<string, string>>;
}

/** Every key under the user-facing sections that no spec header and no reason claims. */
export const unclaimedKeys = (coverage: Coverage): string[] => {
  const claimed = new Set([...coverage.claims, ...Object.keys(coverage.elsewhere)]);
  const { config } = coverage;
  return coverage.sections
    .flatMap((section) => leaves(isObject(config) ? config[section] : undefined, section))
    .filter((key) => !claimed.has(key));
};
