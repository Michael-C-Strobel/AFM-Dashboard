# Automated accessibility audit

`tests/browser-accessibility.mjs` checks all eight inspection tabs in both initial and populated states, normal and expanded modal views, at 1440×1000 and 390×1000: **64 views**. It imports a generated six-pixel calibrated GWYP image and blocks repository measurement requests. Populated states explicitly run acquisition review, batch, a local Assistant plan/evidence report, segmentation, texture, registration and sensitivity. No model endpoint is contacted.

## Current result and limits

The corrected application passes all 64 views with **zero axe WCAG rule violations and zero page errors**, using Chromium 151.0.7922.34 and axe-core 4.10.3. Computed accessibility trees have no unnamed exposed interactive controls. Final evidence: `/tmp/afm-accessibility-audit-VoyvL7/report.json` (after the action-group semantic corrections).

Fixes include native keyboard-operable import/replay buttons, stronger text contrast, valid named action/results groups, and keyboard-scrollable tables, warning lists and source summaries. The native inspection dialog has an accessible name, excludes background controls, retains the scientific snapshot and restores focus on Escape. Chromium, Firefox and WebKit synthetic integration checks exercise Enter/Space file pickers, tab navigation and dialog return.

This is **not a screen-reader certification**. Announcement timing, practical navigation and axe `incomplete` checks require manual review. Remaining incomplete findings concern clipped/text-entry contrast and empty table headers; they are retained in the report rather than suppressed. The test covers synthetic inputs and the documented UI states, not every possible report, provider interaction or browser/assistive-technology combination.

## Reproduce

Install test tools outside the repository; application dependencies are unchanged:

```sh
npm install --prefix /tmp/afm-accessibility-tools --no-audit --no-fund axe-core@4.10.3
PORT=4178 AFM_LIVE_RELOAD=0 node scripts/serve.mjs
# In another terminal:
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium \
AXE_CORE_PATH=/tmp/afm-accessibility-tools/node_modules/axe-core/axe.min.js \
AFM_BASE_URL=http://127.0.0.1:4178/web/ node tests/browser-accessibility.mjs
```

The script prints a unique `/tmp/afm-accessibility-audit-*` directory and writes an incremental checkpoint plus the full JSON report. It collects every axe violation/incomplete finding, computed accessibility trees, visible names, headings, landmarks and live regions. It completes every view before asserting zero WCAG 2 A/AA and 2.1 A/AA violations. The script owns only its browser; the caller owns the server.

The original 32-view audit found 39 rule/view violations (70 affected-node occurrences). Extending it to populated states found eight additional mobile rule/view failures (12 occurrences), all inaccessible scrolling regions. Both groups of findings were fixed and rechecked without disabling rules. Historical evidence remains in `/tmp/afm-accessibility-audit-ClSXGw` and `/tmp/afm-accessibility-audit-kxCbPn`; temporary paths are local diagnostics, not permanent release artifacts.
