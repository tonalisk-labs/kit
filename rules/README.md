# The standard

Every tonalisk project holds all its code and tests to this bar, in every language and paradigm. Someone who wrote none of a change reviews it in this order. A must fix blocks it. A should fix lands with it when that's cheap, or in a change of its own soon after. A note never blocks.

1. **Correct.** Every input and state: empty, one, many, the largest, malformed, offline, concurrent, interrupted, retried. An error keeps the user's data and says what happened.
2. **Secure.** Input is checked where it enters. The server authorises every route itself. No secret, token or user's content reaches a log, an error or analytics.
3. **Fast.** Each path's time and space are the least the problem allows, and hot paths are found by measurement and budgeted, as [budgets.md](budgets.md) says.
4. **Written once.** The helper that exists comes first: the platform's, then kit's. A rule every client shares lives once, as data or in the core.
5. **Clear.** A function does one thing, and its name says what. Types make wrong states impossible to write.
6. **Tested.** Tests check behaviour, each fails if the code is wrong, and each passes beside any other, timed by the processor.
7. **Lean.** Nothing kept that's never shown, no work while idle, and nothing outlives its screen.
8. **Driven by events.** Code waits for the event it needs, never a delay or a poll. A timer is only for time itself, a retry only on a remote signal (a `Retry-After`, a reconnect) and bounded, and a timeout only bounds something outside that can hang. Each says why. Shared state has one owner, and nothing checked before an await is acted on after it unread. Tests hold no sleep, soft check or retry.
9. **Budgeted.** Every budget fails when it's exceeded, and only ever tightens.
10. **Frugal in prose.** A comment says why, never what, in 2 lines at most for a function or type. A Markdown file holds 30 lines at most. `kit-prose` counts both.
11. **Consistent.** The code follows its neighbours, and commits follow the repository's rules.

## The elite limits

A function has a cyclomatic complexity of 10 at most (cognitive, in Rust), nests 3 deep at most and runs 40 lines at most. No block over 10 lines repeats. Each limit lives in a file here, and a repository switches it on once its code meets it, so nothing needs an exception.

| Tool       | How a repository switches it on                                                         |
| ---------- | --------------------------------------------------------------------------------------- |
| oxlint     | `oxlint-elite.json` beside `oxlint.json` in its `extends`                               |
| SwiftLint  | `swiftlint-elite.yml` as its `parent_config`                                            |
| clippy     | `clippy-elite.toml`'s thresholds in its `clippy.toml`, held by `kit-rust-lints --elite` |
| Ruff       | `ruff-elite.toml` as its `extend`                                                       |
| Duplicates | `kit-duplicates`, with jscpd 5.4.2 as a devDependency                                   |
| Prose      | `kit-prose` beside Vale, with `--ignore` for vendored code                              |
| Shell      | ShellCheck at `enable=all`, with functions held to 40 lines in review                   |
