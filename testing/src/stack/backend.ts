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

/** In release, as production runs it. */
export const buildBackend = async (
  crate: string,
  signal: AbortSignal,
  features: readonly string[] = [],
): Promise<string> => {
  const messages = await run(
    'cargo',
    [
      'build',
      '--release',
      '--package',
      crate,
      `--features=${features.join(',')}`,
      '--message-format=json-render-diagnostics',
    ],
    { cwd: REPO, signal },
  );
  const executable = executableOf(messages, crate);
  if (executable === undefined) {
    throw new Error(`cargo built no binary named ${crate}`);
  }
  return executable;
};

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
