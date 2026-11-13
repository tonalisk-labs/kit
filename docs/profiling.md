# Profiling

[budgets.md](../rules/budgets.md) says what is measured and when. This is how to see where the
time and memory go.

A profiler shows names only where they were kept: build with the template's `profiling` profile
(`cargo build --profile profiling`, into `target/profiling`), never in release.

| What               | Tool                                       | Where                          |
| ------------------ | ------------------------------------------ | ------------------------------ |
| A backend's CPU    | `samply record -p <pid>` under load        | Linux and macOS                |
| A backend's heap   | `heaptrack -p <pid>`, then `heaptrack_gui` | Linux                          |
| Rust's allocations | `dhat`, its testing mode in a test binary  | any, one test in each binary   |
| Rust's hot paths   | `criterion`, timing processor time         | any                            |
| Exact instructions | `valgrind --tool=callgrind`                | Linux, where timings are noisy |
| An Apple app       | `xcrun xctrace record --attach`            | a Mac, a device for CPU        |
| The web            | CDP, as the harness's budgets read it      | any                            |

heaptrack slows a backend, so a run it watches fails no budget. A heap that holds level while
resident memory climbs is the allocator keeping freed pages, not the code holding them.

Before a release, `kit-perf-audit` holds a run's readings to their budgets and to the last
release's, from the same machine:

```sh
kit-perf-audit readings.json --last last-release.json
```

Each reading names its unit, whether it is counted work, its budget and every run's sample.
