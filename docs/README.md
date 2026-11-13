# kit's entry points

What each part of `@tonalisk-labs/kit` gives a repo. [Setting one up](use.md) has the snippets,
and [the workflows](workflows.md) cover CI and releases. To work on kit itself, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

| Entry                                   | What it gives                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@tonalisk-labs/kit/testing`            | A Playwright harness and its config: a Docker stack per run, accessibility, SEO and layout checks, budgets, visual baselines |
| `@tonalisk-labs/kit/astro`              | For an `astro.config`: the site's font, its colour themes, Starlight's CSP and scrollable tables, the sitemap's dates        |
| `@tonalisk-labs/kit/theme`              | For pages and scripts: the UI classes, the colour themes and their menu, JSON-LD and Starlight's head                        |
| `@tonalisk-labs/kit/theme.css`          | The Tailwind base, with `starlight.css` and `themes/<id>.css` beside it                                                      |
| `@tonalisk-labs/kit/script`             | For a repo's scripts: how one stops on SIGINT or SIGTERM, steps in turn or in a pool, JSON read without casts                |
| `@tonalisk-labs/kit/components/*.astro` | `Search`, `ThemeSelect`, `StarlightHead` and `BodyFont`                                                                      |
| `@tonalisk-labs/kit/tsconfig.json`      | The TypeScript settings. The oxlint, oxfmt, ruff, SwiftLint, detekt, ktlint, Android Lint and Vale settings are in `rules/`  |
| `kit-lint-styles`, `kit-seo`            | The style lint and the SEO check over the repo's sites                                                                       |
| `kit-test`, `kit-test-rust`             | `node --test` and `cargo llvm-cov`, each held to its coverage floors                                                         |
| crate `kit-server`                      | For Rust backends: typed configuration, a Stripe client, rate limits, problem details, the stop signal, the OpenAPI export   |
| `uvx copier copy gh:tonalisk-labs/kit`  | A new repo set up the same way. A private one gets gitleaks and its own hooks in place of a licence, releases and CI         |
