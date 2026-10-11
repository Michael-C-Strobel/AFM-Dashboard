# Browser performance evidence

Run the optional harness with an existing Playwright installation and Chromium binary:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome \
node scripts/benchmark-browser.mjs
```

The script owns a temporary server on `AFM_TEST_PORT` (default 4180), disables live reload and stops only its own server. It never connects to or stops demo port 4173. `AFM_PERF_SIZES=512,1024` is the default; comma-separated integer sizes 128–2048 are accepted. No package installation is performed.

## Method

Each size gets a fresh browser context and two deterministic, calibrated synthetic GWYP files with identical geometry/title and a 1 nm height offset. Repository measurement requests are blocked; the manifest is empty. Inputs and JSON evidence remain in a unique `/tmp/afm-browser-performance-*` directory. The final results path is printed, including on measured-run failure.

Stages exercise visible controls: importing both files and first analysis, adding mean subtraction, 60 wheel events scheduled one per animation frame, changing to Inferno, and capturing/selecting/running a two-file batch. Readiness uses observable UI completion, not sleep delays. Scientific assertions require expected valid counts, finite means, absolute residual mean below `1e-20 m`, two complete batch records, the mean operation in recipes, and no browser errors.

Elapsed times use browser `performance.now()`. RAF sampling is active before each stage action; completion includes two RAF callbacks. Long Task entries are collected across each stage and flushed before the observer disconnects. Output includes RAF gap count/p95/max and Long Task support/count/max/total. Wheel dispatch measurements are taken wholly inside the page and exclude Playwright transport overhead; whole-stage elapsed measurements include UI automation and readiness overhead. Synthetic wheel events exercise application handlers, not physical input-device latency. These are main-thread observations, not worker CPU profiles.

Evidence records source commit, individual web asset hashes, harness hash, synthetic input hashes, generated recipes/statistics, downloaded batch records, browser/Node/OS/CPU and viewport. Timings are observations only: no arbitrary latency pass/fail thresholds are imposed. Repeat runs before interpreting differences; p95 can hide isolated long stalls, so retain maximums and Long Tasks.

## Baseline observation

Measured against app commit `9acd2507fe0d845c49f161fdb4b9db73c668a8ad`, Chromium 151.0.7922.34, Node 20.20.2, Linux 6.8.0-136-generic, Xeon E5-2667 v3 3.20 GHz (24 logical CPUs), headless viewport 1440×1080. One run per size; all scientific checks passed and no browser errors occurred. Full retained evidence: `/tmp/afm-browser-performance-xqagaw/results.json` (scratch storage is not a permanent archive).

| Size  | Stage                   | Elapsed ms | RAF p95 / max ms | Long tasks count / max / total ms |
| ----- | ----------------------- | ---------: | ---------------: | --------------------------------: |
| 512²  | Import + first analysis |        834 |        233 / 267 |                     2 / 263 / 500 |
| 512²  | Mean subtraction        |        728 |        267 / 267 |                     2 / 252 / 468 |
| 512²  | 60 wheel events         |       1042 |          17 / 17 |                         0 / 0 / 0 |
| 512²  | Palette change          |        297 |        233 / 233 |                     1 / 248 / 248 |
| 512²  | Two-file batch          |        581 |          17 / 17 |                         0 / 0 / 0 |
| 1024² | Import + first analysis |       2583 |         17 / 900 |                    2 / 918 / 1809 |
| 1024² | Mean subtraction        |       2380 |        867 / 900 |                    2 / 918 / 1782 |
| 1024² | 60 wheel events         |       1135 |          33 / 50 |                       1 / 52 / 52 |
| 1024² | Palette change          |        965 |        900 / 900 |                     1 / 919 / 919 |
| 1024² | Two-file batch          |       1248 |          17 / 17 |                         0 / 0 / 0 |

Wheel handler dispatch p95/max was 6.8/14.8 ms at 512² and 15.3/49.8 ms at 1024². Import, processing-result display and palette changes show substantially longer main-thread stalls than warm navigation or batch execution. This identifies stages for further investigation; it does not by itself attribute costs to a particular implementation or establish acceptable user-facing budgets.
