import { REPO } from '../discover.ts';
import { isObject } from '../unknown.ts';
import { run, serve, type Service } from './process.ts';

export const executableOf = (messages: string, crate: string): string | undefined =>
  messages
    .split('\n')
    // Only an artifact line names an executable, so the rest are never parsed.
    .filter((line) => line.startsWith('{') && line.includes('"executable"'))
    .map((line): unknown => JSON.parse(line))
    .map((message) =>
      isObject(message) &&
      message['reason'] === 'compiler-artifact' &&
      isObject(message['target']) &&
      message['target']['name'] === crate &&
      typeof message['executable'] === 'string'
        ? message['executable']
        : undefined,
    )
    .find((executable) => executable !== undefined);

/** `profile` is one the workspace's Cargo.toml defines, release unless named. */
export interface BackendBuild {
  readonly features?: readonly string[];
  readonly profile?: string;
}

/** A profile's name as Cargo takes one (cargo-util-schemas' `validate_profile_name`): letters,
 *  numbers, `_` and `-`, and none it keeps for itself. */
const PROFILE_NAME = /^[\p{Alphabetic}\p{N}_-]+$/u;
const RESERVED_PROFILES = new Set([
  'build-override',
  'build',
  'check',
  'clean',
  'config',
  'fetch',
  'fix',
  'install',
  'metadata',
  'package',
  'publish',
  'report',
  'root',
  'run',
  'rust',
  'rustc',
  'rustdoc',
  'target',
  'tmp',
  'uninstall',
]);
/** A feature's name as Cargo takes one (`validate_feature_name`), so no `/` and no `dep:`. */
const FEATURE_NAME = /^[\p{XID_Start}_0-9][\p{XID_Continue}+.-]*$/u;

/** A package's name as Cargo takes one (`validate_package_name`), so no leading digit or "-". */
const PACKAGE_NAME = /^[\p{XID_Start}_][\p{XID_Continue}-]*$/u;

const packageNamed = (crate: string): string => {
  if (!PACKAGE_NAME.test(crate)) {
    throw new Error(
      `Cargo takes no package named ${JSON.stringify(crate)}: a package's name starts with a ` +
        'letter or "_", then letters, digits, "_" and "-"',
    );
  }
  return crate;
};

const profileNamed = (profile: string): string => {
  const lower = profile.toLowerCase();
  if (!PROFILE_NAME.test(profile) || RESERVED_PROFILES.has(lower) || lower.startsWith('cargo')) {
    throw new Error(
      `Cargo takes no profile named ${JSON.stringify(profile)}: a profile's name is letters, ` +
        'numbers, "_" and "-", and none that Cargo keeps for itself',
    );
  }
  return profile;
};

const featureNamed = (feature: string): string => {
  if (!FEATURE_NAME.test(feature)) {
    throw new Error(
      `Cargo takes no feature named ${JSON.stringify(feature)}: a feature's name starts with a ` +
        'letter, "_" or a digit, then letters, digits, "_", "-", "+" and "."',
    );
  }
  return feature;
};

/** Cargo's arguments, each name refused before anything runs unless Cargo would take it, and
 *  each value its own argument, never joined into another. */
export const buildArguments = (
  crate: string,
  { features = [], profile = 'release' }: BackendBuild,
): string[] => [
  'build',
  '--profile',
  profileNamed(profile),
  '--package',
  packageNamed(crate),
  ...features.flatMap((feature) => ['--features', featureNamed(feature)]),
  '--message-format=json-render-diagnostics',
];

/** In release, as production runs it, or in another profile, such as the template's
 *  `profiling`, which keeps the names and lines a profiler shows. */
export const buildBackendWith = async (
  crate: string,
  signal: AbortSignal,
  build: BackendBuild,
): Promise<string> => {
  const messages = await run('cargo', buildArguments(crate, build), { cwd: REPO, signal });
  const executable = executableOf(messages, crate);
  if (executable === undefined) {
    throw new Error(`cargo built no binary named ${crate}`);
  }
  return executable;
};

/** In release, as production runs it. */
export const buildBackend = async (
  crate: string,
  signal: AbortSignal,
  features: readonly string[] = [],
): Promise<string> => buildBackendWith(crate, signal, { features });

/** With only `env` and PATH, so the caller's shell does not leak in. SIGTERM stops it, and it
 *  drains gracefully. */
export const startBackend = async (
  executable: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Service> =>
  serve(executable, [], {
    cwd: REPO,
    env: Object.fromEntries([
      ['PATH', process.env['PATH'] ?? ''],
      ['NO_COLOR', '1'],
      ...Object.entries(env),
    ]),
    ready: ['listening on'],
    signal,
  });
