# kit

The shared base of the [tonalisk-labs](https://github.com/tonalisk-labs) sites. It's opinionated
and built for those repos, but it's MIT-licensed and versioned with semver, so anyone can use it.

| Entry                                   | What it gives                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@tonalisk-labs/kit/testing`            | A Playwright harness and its config: a Docker stack per run, accessibility, SEO and layout checks, budgets, visual baselines |
| `@tonalisk-labs/kit/astro`              | For an `astro.config`: the site's font, its colour themes, Starlight's CSP and scrollable tables, the sitemap's dates        |
| `@tonalisk-labs/kit/theme`              | For pages and scripts: the UI classes, the colour themes and their menu, JSON-LD and Starlight's head                        |
| `@tonalisk-labs/kit/theme.css`          | The Tailwind base, with `starlight.css` and `themes/<id>.css` beside it                                                      |
| `@tonalisk-labs/kit/script`             | For a repo's scripts: how one stops on SIGINT or SIGTERM, steps in turn or in a pool, JSON read without casts                |
| `@tonalisk-labs/kit/components/*.astro` | `Search`, `ThemeSelect`, `StarlightHead` and `BodyFont`                                                                      |
| `@tonalisk-labs/kit/tsconfig.json`      | The TypeScript settings. The oxlint, oxfmt, ruff, SwiftLint and Vale settings are in `rules/`                                |
| `kit-lint-styles`, `kit-seo`            | The style lint and the SEO check over the repo's sites                                                                       |
| `kit-test`, `kit-test-rust`             | `node --test` and `cargo llvm-cov`, each held to its coverage floors                                                         |
| crate `kit-server`                      | For Rust backends: typed configuration, a Stripe client, rate limits, problem details, the stop signal, the OpenAPI export   |
| `uvx copier copy gh:tonalisk-labs/kit`  | A new repo set up the same way. A private one gets gitleaks and its own hooks in place of a licence, releases and CI         |

## Use

```sh
npm i -D @tonalisk-labs/kit
```

```ts
// playwright.config.ts: each site and app in the repo, on every row of the device matrix
import { defineTests } from '@tonalisk-labs/kit/testing';

export default defineTests();
```

```jsonc
// tsconfig.json
{ "extends": "@tonalisk-labs/kit/tsconfig.json" }
```

```toml
# Cargo.toml
kit-server = { git = "https://github.com/tonalisk-labs/kit", tag = "v1.0.0" }
```

```yaml
# .github/workflows/ci.yml
jobs:
  checks:
    uses: tonalisk-labs/kit/.github/workflows/checks.yml@v1.0.0
```

Renovate keeps all three on the same version through the preset `github>tonalisk-labs/kit`.

## Develop

```sh
mise install && npm ci
mise run check
```

To try a change in a site before releasing it, run `npm run build` here, then
`npm install --no-save ../kit` in the site.

## Workflows

kit is public, so its Actions minutes are free. Every action is pinned to a commit.

| Workflow      | Runs on                                      | What it does                                                    |
| ------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `ci.yml`      | each pull request                            | `mise run check` and the title. On the release PR, `downstream` |
| `publish.yml` | each push to `main`                          | `release.yml` with npm                                          |
| `checks.yml`  | called by the public sites' CI               | `mise run check` and the title                                  |
| `e2e.yml`     | called by the public sites' CI               | the journeys, and at release the screens on arm64               |
| `release.yml` | called by `publish.yml` and the public sites | release-please, then the release, attested                      |

A release builds with a read token only. The files are attested and attached in a job that runs
nothing from the repo, and npm takes the package in another, through
[trusted publishing](https://docs.npmjs.com/trusted-publishers), with no npm token. The
package's provenance names the run that published it.

To set npm up once:

1. Publish a first version by hand, since npm attaches a trusted publisher only to a package that
   exists.
2. In the package's settings on npmjs.com, add GitHub Actions as its trusted publisher:
   `tonalisk-labs/kit`, workflow `publish.yml`, environment `npm`.
3. Under publishing access, require two-factor authentication and disallow tokens.

A private repo runs its checks locally, where `mise run downstream` also checks this build in
each site checked out beside kit.

## Licence

[MIT](LICENSE)
