# Changelog

## [1.1.0](https://github.com/tonalisk-labs/kit/compare/v1.0.7...v1.1.0) (2026-11-14)


### Features

* **testing:** a backend built with a named Cargo profile, and the template's profiling profile ([#34](https://github.com/tonalisk-labs/kit/issues/34)) ([168bca9](https://github.com/tonalisk-labs/kit/commit/168bca919919bf29da13d755f630008128e85b17))
* **testing:** kit-perf-audit, the release audit, and how to profile ([#35](https://github.com/tonalisk-labs/kit/issues/35)) ([37ca9b3](https://github.com/tonalisk-labs/kit/commit/37ca9b3e37f1ae47255c044b20141543ab241713))


### Bug Fixes

* **testing:** a colour read back from the canvas is set once, black where the page can't parse it ([#41](https://github.com/tonalisk-labs/kit/issues/41)) ([8918f35](https://github.com/tonalisk-labs/kit/commit/8918f35e51e4bc472dcdf8eedfbd933d80992f12))
* **testing:** a crash report is new by its folder's listing, not its file's stamp ([#32](https://github.com/tonalisk-labs/kit/issues/32)) ([7582a5b](https://github.com/tonalisk-labs/kit/commit/7582a5b1316f9b26b1f7424652ccd3afc0d46785))
* **testing:** an upstream's failure is logged on one line, whatever its message holds ([#40](https://github.com/tonalisk-labs/kit/issues/40)) ([221fcd6](https://github.com/tonalisk-labs/kit/commit/221fcd6510b9a5e1cb09210d5bab232efc03bf5b))
* **testing:** KIT_ROOT is taken only where it names a folder holding a package.json ([#42](https://github.com/tonalisk-labs/kit/issues/42)) ([15e8f76](https://github.com/tonalisk-labs/kit/commit/15e8f767ca5164cb5c113925ca0029b56302b609))
* **testing:** the budgets file is read without a check first, so it can't change between ([#38](https://github.com/tonalisk-labs/kit/issues/38)) ([7d92479](https://github.com/tonalisk-labs/kit/commit/7d9247923187036579ed1c804154cf09c9f722df))

## [1.0.7](https://github.com/tonalisk-labs/kit/compare/v1.0.6...v1.0.7) (2026-11-14)


### Bug Fixes

* **ci:** kit's publish dry run never asks npm which versions exist, so a release doesn't break the check ([#24](https://github.com/tonalisk-labs/kit/issues/24)) ([7e3b014](https://github.com/tonalisk-labs/kit/commit/7e3b01471514a8430519f68ff954e2db9255bd6f))
* **ci:** the release's SBOM names its repository and version, not the folder syft read ([#31](https://github.com/tonalisk-labs/kit/issues/31)) ([86339de](https://github.com/tonalisk-labs/kit/commit/86339de961b0ca580dd64e2d5d23dedd40eaab13))
* **testing:** a browser leaving mid-upload is no upstream fault, as the edge reads its leaving ([#28](https://github.com/tonalisk-labs/kit/issues/28)) ([9e32d0d](https://github.com/tonalisk-labs/kit/commit/9e32d0d17f77180fcbcea93612bd120aa4f42f14))
* **testing:** a test ends once it has stood still for 132 s, under a one-hour backstop ([#30](https://github.com/tonalisk-labs/kit/issues/30)) ([12cb9d6](https://github.com/tonalisk-labs/kit/commit/12cb9d685ec29e2a1240720b1551e7546d3dc048))
* **testing:** refusals while the stack restarts an upstream are counted, not said, and any other is said once ([#29](https://github.com/tonalisk-labs/kit/issues/29)) ([b554677](https://github.com/tonalisk-labs/kit/commit/b55467767cf81dba513f5fa237df836eddc20447))
* **testing:** slow files are named past a target's setup, whose one test is its build ([#26](https://github.com/tonalisk-labs/kit/issues/26)) ([37f0ae1](https://github.com/tonalisk-labs/kit/commit/37f0ae101261ecd9bc6e735807897b4478a125fa))
* **testing:** the edge ends a dropped live connection with a lingering close, never a reset ([#27](https://github.com/tonalisk-labs/kit/issues/27)) ([c392ebc](https://github.com/tonalisk-labs/kit/commit/c392ebc07292bcdb18b6b618944ec675fb2b28f5))

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
