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

Evidence records source commit, individual web asset hashes, harness hash, synthetic input hashes, generated recipes/statistics, downloaded batch records, browser/Node/OS/CPU and viewport. Reference-workstation budgets are evaluated on every run; `AFM_PERF_ENFORCE=1` makes an exceeded budget fail the process. Repeat runs before interpreting differences; p95 can hide isolated long stalls, so retain maximums and Long Tasks.

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


## Measured improvements and budgets

The renderer now caches ranges for immutable response arrays and interpolates palette colors without per-pixel DOM access or temporary color arrays. An exact before/after check of 18 canvases across three palettes, manual limits and zoom retained identical pixels (`/tmp/afm-render-parity.json`). Large analysis/replay results are serialized to transferable UTF-8 bytes in the worker; the public response remains ordinary JSON. Engine/reader identities, source values, missing-pixel representation and recipe verification are unchanged. A targeted profile measured 612 ms of main-thread serialization before this move.

A subsequent enforced run at 512², 1024² and 2048² passed all scientific assertions and configured budgets. Permanent compact evidence, including measured source hashes and before/after records: [browser-performance-results.json](browser-performance-results.json). Full after-run evidence: `/tmp/afm-browser-performance-wTdqzX/results.json`.

| Size | Import two files + first analysis | Mean operation | Palette change | Two-file batch | Warm wheel dispatch p95 | Longest import main-thread task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 512² | 591 ms | 492 ms | 114 ms | 564 ms | 2.0 ms | 82 ms |
| 1024² | 1714 ms | 1498 ms | 213 ms | 1265 ms | 2.0 ms | 287 ms |
| 2048² | 5940 ms | 5489 ms | 648 ms | 4148 ms | 2.3 ms | 1086 ms |

These are headless observations on the recorded workstation, not universal speed guarantees. At 2048², parsing/display still blocks for about a second; meeting the larger-image budget does not imply continuously smooth interaction during loading. Batch processing remained responsive in these runs. Other operations (especially iterative fitting/texture) have different costs; these budgets apply specifically to the measured mean-subtraction workflow.

Budgets live in `scripts/browser-performance-budgets.json` and their hash is saved with each result:

| Target | Up to 1024² | Up to 2048² |
| --- | ---: | ---: |
| Import two files + first analysis | ≤5 s | ≤15 s |
| Mean operation / two-file batch | ≤4 s each | ≤12 s each |
| Palette change | ≤300 ms | ≤1000 ms |
| Import/mean longest main-thread task | ≤400 ms | ≤1500 ms |
| Palette longest main-thread task | ≤250 ms | ≤900 ms |
| Batch longest main-thread task | ≤100 ms | ≤100 ms |
| Warm navigation dispatch p95 / maximum | ≤8 / 50 ms | ≤8 / 50 ms |
| Warm navigation largest frame gap | ≤100 ms | ≤100 ms |

These targets bound interactive waits and expose regressions; they do not estimate calibration accuracy. Run on an otherwise idle reference machine and retain maximums, because p95 can conceal a long isolated pause. Scientific assertions always fail the script; timing failures are also fatal when explicitly enforced:

```sh
AFM_PERF_ENFORCE=1 AFM_PERF_SIZES=512,1024,2048 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome \
node scripts/benchmark-browser.mjs
```

Default non-enforcing runs still record each metric, limit and pass/fail result. A missing Long Tasks API cannot silently pass its budget. Keep performance runs separate from parallel browser/audit jobs; shared-runner timing gates are not enabled in hosted CI.


The separate real-file regression measured import plus first analysis at 8.57 s for the eight-channel NanoScope fixture, 2.17 s for eight-channel IBW, and 0.72 s for ten-channel JPK. Those files include multiple channels and format-specific decoding/calibration; the single-channel synthetic import budgets must not be presented as vendor-file guarantees. All imports and strict replay checks passed (`/tmp/afm-browser-qNtSa2`).
