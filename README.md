# kit

The shared base of the [tonalisk-labs](https://github.com/tonalisk-labs) sites. It's built for
those repos, but it's MIT-licensed and follows semver, so anyone can use it.

```sh
npm i -D @tonalisk-labs/kit
```

Most repos start with two things. Their `tsconfig.json` extends `@tonalisk-labs/kit/tsconfig.json`,
and their Playwright config runs every test across browsers, screens and networks:

```ts
import { defineTests } from '@tonalisk-labs/kit/testing';
export default defineTests();
```

The rest (Astro and the theme, the Rust crate `kit-server`, the CI workflows and the repo
template) is in [the docs](docs/README.md).
