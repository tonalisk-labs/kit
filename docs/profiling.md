# Profiling

[budgets.md](../rules/budgets.md) says what is measured and when; this is how to see where the
time and memory go. A Rust profile shows names only from the template's `profiling` build
(`cargo build --profile profiling`, into `target/profiling`), never from release.

| What               | Tool                                                             | Where                          |
| ------------------ | ---------------------------------------------------------------- | ------------------------------ |
| A backend's CPU    | `samply record -p <pid>` under load (`samply setup` on a Mac)    | Linux and macOS                |
| A backend's heap   | `heaptrack -p <pid>`, then `heaptrack_gui`                       | Linux                          |
| Rust's allocations | `dhat`, its testing mode in a test binary                        | any, one test in each binary   |
| Rust's hot paths   | `criterion`, given a processor-time `Measurement`                | any                            |
| Exact instructions | `valgrind --tool=callgrind`                                      | Linux, where timings are noisy |
| An Apple app       | `xcrun xctrace record --template 'Time Profiler' --attach <app>` | a Mac, a device for CPU        |
| The web            | CDP, as the harness's budgets read it                            | any                            |

heaptrack slows a backend, so a run it watches fails no budget. A heap that holds level while
resident memory climbs is the allocator keeping freed pages, not the code holding them.

Before a release, `kit-perf-audit readings.json --last last-release.json` holds a run's readings
to their budgets and to the last release's from the same machine. The repo writes the readings,
each budget as its budgets file gives it, and keeps them with the release, out of the tree its
gate must leave clean. A file holds its `machine` and its `readings`, each a `name`, a `unit`,
whether it is `counted` work, its `budget` and every run's `samples` (`Readings` in
`@tonalisk-labs/kit/testing`).
