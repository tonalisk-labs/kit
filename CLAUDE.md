# kit

The shared base of the tonalisk-labs sites: the E2E harness, the theme, the rules every repo extends, and kit-server.

- `mise run check` before every push, and keep it green.
- Commits follow Conventional Commits, and each describes the code it changes.
- Comments say only what the code can't: why, an invariant, an edge case, an outside constraint.
- Every tonalisk-labs repo installs this package: keep its exports stable, and mark a breaking change
  with `!` so it releases as a major.
