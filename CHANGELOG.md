# Changelog

## 1.0.1 (2026-11-11)

The README fits on one screen, and the rest of it moves to docs/. The GitHub Pages deploy is its
own reusable workflow, pages.yml, so kit's own release no longer asks for permission to deploy a
site (that stopped it at startup). A repo that serves a site calls pages.yml after release.yml.

Like 1.0.0, this version was built and published from the maintainer's machine, so npm records no
provenance for it.

## 1.0.0 (2026-11-10)

The first public release: the E2E harness, the theme, the rules every tonalisk-labs repo extends,
kit-server, and the Copier template.

1.0.0 was built and published from the maintainer's machine after kit's release check passed there,
so npm records no provenance for it. Later versions move to the release workflow, which builds,
attests and publishes each one with provenance.
