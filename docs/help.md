# Using the AFM workspace

**Start with Import local files**, then choose a source and channel. Read **Import support**, warnings and channel metadata before measuring. Supported formats are image subsets, not blanket instrument compatibility. Check the [supported-input matrix](supported-inputs.md); unknown units remain unknown.

## View and measure

Select an **Operation**, then **Add operation & apply**. Review History, use **Undo**, or **Reset pipeline**. Processing preserves original measurements. Robust leveling is a starting point requiring scientific review; the chemist preset is available only for its identified source/channel.

Use **Selection tool** for an ROI, profile or exclusion polygon. In **Measurements**, **Enter exact selection coordinates** provides a keyboard alternative in source base units. Recalculate after edits. To measure a step, save one ROI as **plateau A**, then another as **plateau B**. Plateaus are independent of the global ROI; exclusions still apply. Pixel spreads are not confidence intervals.

Inspection tabs support Left/Right and Home/End keys. **Expand inspection** opens a larger modal; Escape returns to the viewer. On narrow screens, **Data & processing** reveals source and pipeline controls.

## Choose an analysis

- **Acquisition quality:** run the check on the original channel and inspect [diagnostic candidates](quality.md). Candidates are not identified defects.
- **Batch:** capture a completed recipe, refresh the file list, select inputs, check compatibility and start. Each input gets a new recipe; [download records before reload](browser-batch.md).
- **Features:** capture processed analysis, review threshold/unit/connectivity rules, then segment. Inspect [accepted and excluded regions](segmentation-workflows.md).
- **Texture:** capture, choose detrending/window and measure a complete valid rectangle. [Numerical TAR exports](texture-workflows.md) retain full arrays beyond the displayed bin means.
- **Registration:** capture fixed and moving surfaces, choose an explicit translation/search and review [overlap, ties and residuals](registration-workflows.md). No deformation is inferred.
- **Sensitivity:** capture a baseline, review alternative processing/selections and run. Inspect failures and changed pixel populations; [alternative spread is not calibration uncertainty](sensitivity-workflows.md).

## Save evidence and review automation

**Save recipe** retains legacy format. **Save portable recipe** verifies a captured analysis and adds reorder-safe checksums. **Load recipe** accepts either format up to 1 MiB; replay requires exact inputs and matching code. [Portable recipe guidance](recipe-interchange.md) explains migration. **Export analysis TAR** includes results and provenance, not original measurement bytes.

In **Assistant**, refresh sources, choose a starter, inspect arguments, validate and explicitly run. Plans operate independently of the viewer pipeline. [Verify evidence](evidence-reports.md) and download the plan, journal and artifacts. Optional [model planning](model-provider.md) sends selected metadata and only opted-in compact evidence; it never executes proposals automatically. Recorded model-selected claims are not new scientific inference.

Imports and unfinished work are session-only. Download evidence before reloading. Compatibility warnings, descriptive statistics and successful replay do not certify calibration or interpretation.

## Deterministic help context

`web/help-knowledge.js` exposes curated topic IDs, titles, instructions and existing interface targets. `helpContext({tab})` accepts an exact DOM tab ID (for example `tab-texture`), prioritizes relevant topics and returns detached plain JSON below 32 KiB. Unknown tab values become null. It reads no DOM content or measurements. `resolveHelpTopics(ids)` accepts 1–8 unique known IDs and returns detached topics; no provider or execution behavior is included.
