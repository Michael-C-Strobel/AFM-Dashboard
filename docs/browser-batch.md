# Browser batch analysis

The batch card applies a captured processing recipe to explicitly selected new inputs. It creates a new per-file recipe with input and output hashes. It does not claim that a different input is a replay of the source measurement.

## Workflow

1. Analyze a source channel successfully, then choose **Capture current recipe**. Dirty selections or a pending/failed analysis block capture.
2. Disable reference comparison and recalculate before capture: templates containing reference comparisons are rejected.
3. Select files from the list. **Refresh file list** includes newly imported measurements.
4. Use **Check selected inputs** to inspect compatibility and reader warnings. The channel, title, geometry, units, schema, and engine identity must match the template.
5. Start the batch. Processing is sequential; an incompatible file fails independently and later files continue.
6. Download the manifest or a completed file’s recipe. **Export verified TAR** strictly replays that result before generating its archive.

The captured template is detached from later interactive edits. Source maps and the interactive pipeline are not changed by batch execution. File selection, capture, reset, preflight, and other exports are disabled during a job or TAR export. Cancel finishes the current file and marks remaining inputs `not_run`.

Warnings and instrument support status come from the importer; compatibility does not certify an instrument configuration. The browser retains metadata and recipes, not batch raster arrays. Downloads require explicit clicks. Reloading the page does not resume the job; save the manifest before leaving.

## Optional browser verification

Use an existing Playwright installation and Chromium; no packages are installed by the test.

```sh
PORT=4174 npm run dev
AFM_BASE_URL=http://127.0.0.1:4174/web/ node tests/browser-batch.mjs
```

Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if those dependencies are outside normal lookup paths. The test uses a browser-only response gate to make cancellation deterministic; production code contains no delay hook.

The final batch run passed:

- Explicit compatible raw/worked inputs completed around an incompatible geometry failure.
- Dirty capture was blocked; reference-bearing capture was rejected.
- Later interactive edits left the captured template unchanged, including while a batch was active.
- Source map bytes and interactive output hashes remained unchanged by batch execution.
- Manifest, per-file recipe, and verified TAR downloads matched the completed results.
- Cancellation yielded `complete`, then `not_run`.
- Reader warnings remained visible; mobile layout had no horizontal overflow; no console errors occurred.

Batch artifacts: `/tmp/afm-batch-browser-RCiLCH`. Screenshot: `/tmp/afm-browser-batch.png`. The existing full viewer/importer/acquisition smoke suite also passed, with artifacts in `/tmp/afm-browser-s160NL`.
