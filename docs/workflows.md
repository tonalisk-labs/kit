# kit's workflows

kit is public, so its Actions minutes are free. Every action is pinned to a commit.

| Workflow      | Runs on                                      | What it does                                      |
| ------------- | -------------------------------------------- | ------------------------------------------------- |
| `ci.yml`      | each pull request                            | `mise run check` and the title                    |
| `publish.yml` | each push to `main`                          | `release.yml` with npm                            |
| `checks.yml`  | called by the public sites' CI               | `mise run check` and the title                    |
| `e2e.yml`     | called by the public sites' CI               | the journeys, and at release the screens on arm64 |
| `release.yml` | called by `publish.yml` and the public sites | release-please, then the release, attested        |
| `pages.yml`   | called by the public sites after a release   | the site, deployed to GitHub Pages                |

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
