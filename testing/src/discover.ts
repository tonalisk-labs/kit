import { spawnSync } from 'node:child_process';
import { existsSync, globSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** A site or app frontend under test, found by its Astro config. */
export interface Target {
  readonly name: string;
  readonly root: string;
  /** `tests/app.ts`, where an app declares its services and its own checks. */
  readonly adapter: string | undefined;
}

/** The folder `named`, refused unless it holds a package.json as a repo's root does, so a stray
 *  value never reaches a child process as its folder or argument. */
export const repoNamed = (named: string): string => {
  const repo = path.resolve(named);
  const manifest = statSync(path.join(repo, 'package.json'), { throwIfNoEntry: false });
  if (manifest === undefined || !manifest.isFile()) {
    throw new Error(`KIT_ROOT names ${JSON.stringify(named)}, which holds no package.json`);
  }
  return repo;
};

const kitRoot = process.env['KIT_ROOT'];
/** The repo under test: the one whose `playwright.config.ts` runs, or `KIT_ROOT`. */
export const REPO = kitRoot === undefined ? path.resolve(process.cwd()) : repoNamed(kitRoot);

/** The checkout `folder` is the top of, and the git directory it shares with every worktree of its
 *  repo; undefined outside git. The variables a git hook sets would answer for another folder. */
const checkoutOf = (folder: string): { top: string; shared: string } | undefined => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const asked = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    { cwd: folder, encoding: 'utf8', env },
  );
  const [top, shared] = asked.status === 0 ? asked.stdout.trim().split('\n') : [];
  return top === undefined || shared === undefined ? undefined : { top, shared };
};

/** The repo's name, the folder of the `.git` its worktrees share, so a worktree's targets and their
 *  budgets go by the main checkout's; outside git, in a subfolder or a submodule, its own. */
const repoName = (repo: string): string => {
  const checkout = checkoutOf(repo);
  return checkout !== undefined &&
    checkout.top === realpathSync(repo) &&
    path.basename(checkout.shared) === '.git'
    ? path.basename(path.dirname(checkout.shared))
    : path.basename(repo);
};

/** The sites and app frontends under `repo`, each found by its Astro config: at the root, or in
 *  a folder of its own. A repo with one is named for the repo, one with several `<repo>/<folder>`. */
export const discoverIn = (repo: string): Target[] => {
  const configs = globSync('{astro.config.*,*/astro.config.*}', { cwd: repo }).toSorted();
  if (configs.length === 0) {
    return [];
  }
  const named = repoName(repo);
  return configs.map((config) => {
    const folder = path.dirname(config);
    const root = path.join(repo, folder);
    const adapter = path.join(root, 'tests', 'app.ts');
    return {
      name: folder === '.' || configs.length === 1 ? named : `${named}/${folder}`,
      root,
      adapter: existsSync(adapter) ? adapter : undefined,
    };
  });
};

/** The targets of the repo under test. */
export const discover = (): Target[] => discoverIn(REPO);
