# Changelog

## [1.0.6](https://github.com/tonalisk-labs/kit/compare/v1.0.5...v1.0.6) (2026-11-13)


### Bug Fixes

* **ci:** npm publishes the release's tarball by a file path, which kit's check dry-runs ([#21](https://github.com/tonalisk-labs/kit/issues/21)) ([778b019](https://github.com/tonalisk-labs/kit/commit/778b019bfc46c921c0f3a8f60341211e281d9f70))

## [1.0.5](https://github.com/tonalisk-labs/kit/compare/v1.0.4...v1.0.5) (2026-11-13)


### Bug Fixes

* **deps:** astro 7.4.9, past the two advisories published against 7.3.8 ([#18](https://github.com/tonalisk-labs/kit/issues/18)) ([9db19e7](https://github.com/tonalisk-labs/kit/commit/9db19e7485702ddc4b1678c9e99ee3ba102d7f2f))
* **testing:** an abandoned image is left once its decoder has its size, as Firefox needs to report it ([#20](https://github.com/tonalisk-labs/kit/issues/20)) ([0e38e57](https://github.com/tonalisk-labs/kit/commit/0e38e57cb540a116cf5e431e6a2200e01818a6be))

## [1.0.4](https://github.com/tonalisk-labs/kit/compare/v1.0.3...v1.0.4) (2026-11-13)


### Bug Fixes

* **ci:** a release is a draft until its files and package are in place ([#12](https://github.com/tonalisk-labs/kit/issues/12)) ([f29529f](https://github.com/tonalisk-labs/kit/commit/f29529fd6b5542e0e0a94eac10e1b5cadec8f444))
* **testing:** kit-test's timed phase holds the machine's CPU gate whole ([#14](https://github.com/tonalisk-labs/kit/issues/14)) ([b0de96c](https://github.com/tonalisk-labs/kit/commit/b0de96c5ac0cd91c74cb3ba51b5c2ac366e8cf61))

## [1.0.3](https://github.com/tonalisk-labs/kit/compare/v1.0.2...v1.0.3) (2026-11-12)


### Bug Fixes

* **ci:** install the pinned Rust toolchain once, before any task runs cargo ([#8](https://github.com/tonalisk-labs/kit/issues/8)) ([c3b2459](https://github.com/tonalisk-labs/kit/commit/c3b245981f3345db2f3f85bda91fd93fe0b96855))

## [1.0.2](https://github.com/tonalisk-labs/kit/compare/v1.0.1...v1.0.2) (2026-11-12)


### Bug Fixes

* a site's check and release clone the whole history, with Lighthouse 13.6.0 ([#6](https://github.com/tonalisk-labs/kit/issues/6)) ([137b953](https://github.com/tonalisk-labs/kit/commit/137b9535c5f36e5c1c78b3ddc33e55380fe6f328))
* **release:** kit's release workflow publishes it to npm itself, with provenance ([710cf3e](https://github.com/tonalisk-labs/kit/commit/710cf3e3b3d74d5c633a6e8410f7d024610e6209))
* **release:** release-please's pull request passes kit's own check, Cargo.lock included ([#4](https://github.com/tonalisk-labs/kit/issues/4)) ([96b705b](https://github.com/tonalisk-labs/kit/commit/96b705b4ceabbd1fca50af22749008ef97c750c7))
* **testing:** a Covers header reads its own line only, in linear time ([#3](https://github.com/tonalisk-labs/kit/issues/3)) ([597ea2d](https://github.com/tonalisk-labs/kit/commit/597ea2dd810e2bdd72080245d65e8ea52ad89f2c))
* **testing:** shared browsers with seats per test, and every hold's wait bounded ([#7](https://github.com/tonalisk-labs/kit/issues/7)) ([5002c9b](https://github.com/tonalisk-labs/kit/commit/5002c9b56db1b20f2d61ce091d62ae7e6d79bc66))

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
