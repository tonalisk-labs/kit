# Setting kit up

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
kit-server = { git = "https://github.com/tonalisk-labs/kit", tag = "v1.0.1" }
```

```yaml
# .github/workflows/ci.yml
jobs:
  checks:
    uses: tonalisk-labs/kit/.github/workflows/checks.yml@v1.0.1
```

Renovate keeps all three on the same version through the preset `github>tonalisk-labs/kit`.
