# Budgets and hot paths

A budget that only reports doesn't exist. Every one fails its suite when it's exceeded, lives in the repository's one budgets file (`perf-budgets.json`, or the file it names to `kit-size --budgets` and `defineTests`), and only ever tightens.

## Where a budget comes from

1. **The strictest published threshold.** On the web, RAIL (a response in 100 ms, a frame in 16 ms, tasks under 50 ms) and Core Web Vitals' "good" held at half (LCP 1.2 s, INP 100 ms, CLS 0.05) on a mid-range phone. On Apple, hitches under 2 ms/s, no hang over 100 ms, a first frame within 400 ms of a cold launch, and 8 ms frames at 120 Hz. On the server, 10 ms of processor time a request, 2 ms a relay frame, and every query on an index.
2. **Then the best the code has shown.** Where the code does better than the threshold, the budget is what it measures plus its noise, never the looser threshold.
3. **A fixed cost and a slope.** Each operation is measured at four sizes (10 to 10,000 notes, 1 KB to 1 MB, 1 to 365 days). A least-squares fit gives both, and the log-log slope gives the growth class, which must be the one the design requires. A wrong slope fails while the total still fits.

## How it's measured

- **Counted work first.** Requests, queries, bytes, allocations, frames and renders are exact, and held exactly.
- **Processor time, never the wall clock.** The median of 5 runs or more, with the budget at the median plus 3 median absolute deviations, set from 10 runs on the release machine. Memory is read after a forced settle, as the median of 5.
- **A regression** is over its budget and significant, by a Mann-Whitney U test at p < 0.01, so noise can't fail a change and a real regression can't hide in it.
- **Measured runs** have the machine to themselves.
- **The ratchet.** A change that measures more than 10% better writes the new value. Loosening one needs the maintainer's decision, recorded with its reason in the file.
- **Before every release** the measured suites run last in its gate, after the end-to-end journeys and never beside them, and `kit-perf-audit` holds each reading to its budget and to the last release's from the same machine. The release keeps its readings and that machine's name, and the audit names each budget the ratchet may tighten.

## Finding the hot paths

- **Every path, by its input.** Each function's time and space in the sizes it depends on (notes, a note's length, days, devices), at the least the problem allows wherever an input can grow.
- **Every operation, by how often it runs.** Per keystroke, per frame, per sync, per open, per session, or rare. Each class takes its latency budget from the thresholds above.
- **Profiled at ten times today's largest use** (10,000 notes, a 1 MB note, a year of days), with CDP on the web, `xctrace` on Apple (Time Profiler, CPU Counters, and the SwiftUI and Swift Concurrency instruments), `criterion` and `dhat` in Rust, and samply and heaptrack on a backend under load, built with the template's `profiling` profile, which keeps the names a profiler shows. A function is hot when it's in the set taking 80% of its operation's processor time, or when its operation misses its budget.
- **Minimal means** no allocation per keystroke or frame beyond the edit's own, nothing copied that can be read in place, caches bounded, and memory back at its level after each operation.
- **What follows.** A hot path gets a performance test at that scale, with processor-time and memory budgets, and a kept profile. A per-keystroke, per-frame or per-sync path gets a budget test. Every other path is checked in review.
