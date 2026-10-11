# Automated accessibility audit

Audit of base `9acd250` using Chromium 1234, Playwright and axe-core **4.10.3**, with a generated 3×2 calibrated GWYP file. Repository measurements were blocked and the manifest replaced with an empty list. All eight inspection tabs were checked in their initial post-import state, normal and expanded native-modal views, at 1440×1000 and 390×1000. This does not cover populated analysis results, provider dialogs or screen-reader operation.

**Result: failed.** 32 views completed; 39 WCAG rule/view violations and 70 affected-node occurrences (repeated controls across views count repeatedly). Zero page errors. No unnamed exposed button/textbox/combobox/checkbox/radio/spinbutton/slider/searchbox nodes were found in the captured Chromium accessibility trees. Automated checks are not screen-reader certification.

Full evidence and incremental checkpoint: `/tmp/afm-accessibility-audit-ClSXGw/report.json` and `progress.md`. The report includes every axe violation and incomplete finding, computed accessibility trees, visible control labeling sources, live regions, headings and landmarks. Unresolved axe `incomplete` checks require manual review.

## Findings by view

Counts below are affected nodes, including additional best-practice findings; no rules were suppressed.

| Width | Mode     | Tab          | Rule IDs and node counts                                         |
| ----- | -------- | ------------ | ---------------------------------------------------------------- |
| 1440  | normal   | measurements | aria-allowed-role: 2; color-contrast: 7                          |
| 1440  | normal   | acquisition  | aria-allowed-role: 2; color-contrast: 3                          |
| 1440  | normal   | batch        | aria-allowed-role: 2; color-contrast: 3                          |
| 1440  | normal   | assistant    | aria-allowed-role: 2; aria-prohibited-attr: 1; color-contrast: 3 |
| 1440  | normal   | features     | aria-allowed-role: 2; color-contrast: 3                          |
| 1440  | normal   | texture      | aria-allowed-role: 2; aria-prohibited-attr: 1; color-contrast: 3 |
| 1440  | normal   | registration | aria-allowed-role: 2; color-contrast: 3                          |
| 1440  | normal   | sensitivity  | aria-allowed-role: 2; aria-prohibited-attr: 1; color-contrast: 3 |
| 1440  | expanded | measurements | color-contrast: 5                                                |
| 1440  | expanded | acquisition  | color-contrast: 1                                                |
| 1440  | expanded | batch        | color-contrast: 1                                                |
| 1440  | expanded | assistant    | aria-prohibited-attr: 1; color-contrast: 1                       |
| 1440  | expanded | features     | color-contrast: 1                                                |
| 1440  | expanded | texture      | aria-prohibited-attr: 1; color-contrast: 1                       |
| 1440  | expanded | registration | color-contrast: 1                                                |
| 1440  | expanded | sensitivity  | aria-prohibited-attr: 1; color-contrast: 1                       |
| 390   | normal   | measurements | color-contrast: 5                                                |
| 390   | normal   | acquisition  | color-contrast: 1                                                |
| 390   | normal   | batch        | color-contrast: 1                                                |
| 390   | normal   | assistant    | aria-prohibited-attr: 1; color-contrast: 1                       |
| 390   | normal   | features     | color-contrast: 1; scrollable-region-focusable: 1                |
| 390   | normal   | texture      | aria-prohibited-attr: 1; color-contrast: 1                       |
| 390   | normal   | registration | color-contrast: 1                                                |
| 390   | normal   | sensitivity  | aria-prohibited-attr: 1; color-contrast: 1                       |
| 390   | expanded | measurements | color-contrast: 4                                                |
| 390   | expanded | acquisition  | none                                                             |
| 390   | expanded | batch        | none                                                             |
| 390   | expanded | assistant    | aria-prohibited-attr: 1                                          |
| 390   | expanded | features     | scrollable-region-focusable: 1                                   |
| 390   | expanded | texture      | aria-prohibited-attr: 1                                          |
| 390   | expanded | registration | none                                                             |
| 390   | expanded | sensitivity  | aria-prohibited-attr: 1                                          |

## Exact targets

| Rule                          | Selector                                             | Occurrences across views |
| ----------------------------- | ---------------------------------------------------- | -----------------------: |
| `aria-allowed-role`           | `.import-button`                                     |                        8 |
| `aria-allowed-role`           | `.button-row:nth-child(22) > .button[role="button"]` |                        8 |
| `color-contrast`              | `.mark`                                              |                        8 |
| `color-contrast`              | `.display-help > summary`                            |                       16 |
| `color-contrast`              | `.dock-label`                                        |                       16 |
| `color-contrast`              | `.stat:nth-child(1) > span`                          |                        4 |
| `color-contrast`              | `.stat:nth-child(2) > span`                          |                        4 |
| `color-contrast`              | `.stat:nth-child(3) > span`                          |                        4 |
| `color-contrast`              | `.stat:nth-child(4) > span`                          |                        4 |
| `aria-prohibited-attr`        | `#assistant-results`                                 |                        4 |
| `aria-prohibited-attr`        | `#texture-summary`                                   |                        4 |
| `aria-prohibited-attr`        | `#sensitivity-rows`                                  |                        4 |
| `scrollable-region-focusable` | `.features-table`                                    |                        2 |

Contrast failures affect the monogram, dock label, display-help summary and four measurement labels. For example `.mark` measured 4.41:1 against a required 4.5:1; exact foreground/background colors and ratios for every occurrence are retained in report.json. `aria-prohibited-attr` flags accessible-name attributes on generic containers. `scrollable-region-focusable` flags the mobile Features table container. `aria-allowed-role` is retained as an additional best-practice finding for file-upload labels carrying button roles.

The expanded inspection uses an open native `dialog` matching `:modal`, has an accessible naming source, places focus inside the dialog and closes with Escape in every audited view. Its modal background is excluded from the accessibility tree. Status/live-region roles and visible heading/landmark sequences are recorded, but announcement timing and practical screen-reader navigation were not assessed.

## Reproduce

Install optional tools outside the repository; the app has no new dependencies. Start a server from the checkout being audited, then run:

```sh
npm install --prefix /tmp/afm-accessibility-tools --no-audit --no-fund axe-core@4.10.3
PORT=4178 AFM_LIVE_RELOAD=0 node scripts/serve.mjs
# In a second terminal:
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium \
AXE_CORE_PATH=/tmp/afm-accessibility-tools/node_modules/axe-core/axe.min.js \
AFM_BASE_URL=http://127.0.0.1:4178/web/ node tests/browser-accessibility.mjs
```

The script creates a unique `/tmp/afm-accessibility-audit-*` directory and prints its location immediately. It runs every view before asserting zero WCAG 2 A/AA and WCAG 2.1 A/AA violations, so current findings intentionally produce a nonzero exit. The script closes its browser; the invoking user owns server lifecycle. The audit’s own server on 4178 was stopped afterward; demo 4173 was untouched. No app fixes are included in this evidence commit.
