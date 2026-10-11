/** Optional local Assistant integration QA; requires existing Playwright/Chromium. */
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 },
  acceptDownloads: true,
});
const scratch = await mkdtemp(join(tmpdir(), "afm-assistant-"));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
async function download(locator, name) {
  const event = page.waitForEvent("download");
  await locator.click();
  const file = join(scratch, name);
  await (await event).saveAs(file);
  return JSON.parse(await readFile(file, "utf8"));
}
async function journal() {
  return page.evaluate(async () => {
    const { apiFetch } = await import("./api.js");
    return (await apiFetch("/api/tool-journal")).json();
  });
}
async function finished() {
  await page.waitForFunction(
    () => !document.querySelector("#assistant-validate").disabled,
    {},
    { timeout: 60000 },
  );
}
async function run() {
  await page.locator("#assistant-validate").click();
  assert.equal(await page.locator("#assistant-run").isDisabled(), false);
  await page.locator("#assistant-run").click();
  await finished();
}
try {
  const source = await readFile(
    new URL("../web/api.js", import.meta.url),
    "utf8",
  );
  const gated =
    source.replace(
      "export async function apiFetch(",
      "async function internalApiFetch(",
    ) +
    '\nexport async function apiFetch(path,options={}) { const result=await internalApiFetch(path,options);if(path==="/api/tool"&&globalThis.__assistantHold)await new Promise(resolve=>globalThis.__assistantRelease=resolve);return result;}\n';
  await page.route("**/web/api.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: gated }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4174/web/");
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
    {},
    { timeout: 60000 },
  );
  const before = await page
    .locator("canvas")
    .evaluateAll((nodes) => nodes.map((node) => node.toDataURL()));
  const originalRecipe = await download(
    page.locator("#download"),
    "original.json",
  );
  await page.locator("#tab-batch").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-assistant").getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.locator("#panel-assistant").isVisible(), true);
  assert.equal(await page.locator("#panel-batch").isVisible(), false);
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-robust").disabled,
    {},
    { timeout: 60000 },
  );
  await page
    .locator("#assistant-source")
    .selectOption("sample-input.gwy");
  await page.waitForFunction(
    () => !document.querySelector("#assistant-robust").disabled,
  );
  await page.locator("#assistant-channel").selectOption("0");
  await page.locator("#assistant-robust").click();
  const draft = JSON.parse(await page.locator("#assistant-plan").inputValue());
  assert.deepEqual(
    draft.steps.map((s) => s.call.name),
    ["inspect_source", "analyze_surface", "replay_recipe"],
  );
  assert.equal(
    draft.steps[1].call.arguments.source_sha256,
    originalRecipe.source.sha256,
  );
  assert.equal(draft.steps[1].call.arguments.channel, "0");
  assert.equal(draft.steps[2].call.arguments.recipe_artifact, "$step:analyze");
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  const countBefore = (await journal()).records.length;
  await page.locator("#assistant-validate").click();
  assert.equal(
    (await journal()).records.length,
    countBefore,
    "Validation executes no tools",
  );
  const planned = await download(
    page.locator("#assistant-download-plan"),
    "plan.json",
  );
  assert.equal(planned.steps.length, 3);
  await page.locator("#assistant-run").click();
  await finished();
  const manifest = await download(
    page.locator("#assistant-download-run"),
    "run.json",
  );
  assert.equal(manifest.status, "complete");
  assert.deepEqual(
    manifest.steps.map((s) => s.status),
    ["complete", "complete", "complete"],
  );
  const analyzed = manifest.steps[1].result.artifact.content.result,
    replayed = manifest.steps[2].result.artifact.content.result;
  assert.ok(Number.isFinite(analyzed.statistics.sa));
  assert.equal(replayed.replay_verified, true);
  assert.equal(analyzed.recipe.output.sha256, replayed.recipe.output.sha256);
  assert.equal(
    manifest.steps[2].resolved_call.arguments.recipe_artifact,
    manifest.steps[1].result.artifact.id,
  );
  const artifact = await download(
    page
      .locator('[data-step="analyze"]')
      .getByRole("button", { name: "Download artifact JSON" }),
    "artifact.json",
  );
  assert.equal(artifact.id, manifest.steps[1].result.artifact.id);
  const recipe = await download(
    page
      .locator('[data-step="analyze"]')
      .getByRole("button", { name: "Download recipe", exact: true }),
    "recipe.json",
  );
  assert.equal(recipe.output.sha256, analyzed.recipe.output.sha256);

  await page.locator("#assistant-report-create").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#assistant-report-json").disabled ||
      document.querySelector("#assistant-status").classList.contains("error"),
  );
  assert.equal(
    await page.locator("#assistant-report-json").isDisabled(),
    false,
    await page.locator("#assistant-status").textContent(),
  );
  const report = await download(
    page.locator("#assistant-report-json"),
    "report.json",
  );
  assert.equal(report.claims.length, 16);
  assert.equal(report.plan_sha256, manifest.plan_sha256);
  assert.equal(await page.locator("#assistant-report tbody tr").count(), 16);
  for (const claim of report.claims) {
    assert.equal(claim.source_sha256, originalRecipe.source.sha256);
    assert.equal(claim.channel, "0");
    assert.equal(
      claim.unit,
      ["valid_count", "excluded_count"].includes(claim.metric)
        ? "pixels"
        : claim.metric === "area"
          ? "(m)²"
          : "m",
    );
    const target = "#artifact-" + claim.artifact_id.slice(9);
    assert.equal(await page.locator(target).count(), 1);
    assert.ok(
      (await page
        .locator('#assistant-report a[href="' + target + '"]')
        .count()) > 0,
    );
  }
  const firstLink = page.locator("#assistant-report a").first();
  const destination = await firstLink.getAttribute("href");
  await firstLink.click();
  assert.equal(
    await page.locator(destination).evaluate((node) => node.open),
    true,
  );
  const markdownEvent = page.waitForEvent("download");
  await page.locator("#assistant-report-markdown").click();
  const markdownPath = join(scratch, "report.md");
  await (await markdownEvent).saveAs(markdownPath);
  const markdown = await readFile(markdownPath, "utf8");
  assert.equal(markdown, report.markdown);
  assert.ok(markdown.includes(destination));
  assert.match(
    await page.locator("#assistant-report").textContent(),
    /not a signature or calibration certification/,
  );

  const evidence = await download(
    page.locator("#assistant-download-journal"),
    "journal.json",
  );
  assert.equal(evidence.records.at(-1).status, "succeeded");
  assert.ok(evidence.records.every((r) => /^[0-9a-f]{64}$/.test(r.sha256)));
  assert.deepEqual(
    await page
      .locator("canvas")
      .evaluateAll((nodes) => nodes.map((node) => node.toDataURL())),
    before,
    "Tool plans preserve interactive source maps",
  );
  assert.equal(await page.locator("#history li").count(), 0);
  await page
    .locator("#panel-assistant")
    .evaluate((node) => (node.scrollTop = 0));
  await page.screenshot({ path: "/tmp/afm-assistant-desktop.png" });
  await page.locator(".assistant-advanced summary").click();
  const stale = structuredClone(draft);
  stale.steps[1].call.arguments.source_sha256 = "0".repeat(64);
  await page.locator("#assistant-plan").fill(JSON.stringify(stale));
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  assert.equal(
    await page.locator("#assistant-report tbody tr").count(),
    16,
    "Draft edits preserve the explicitly labeled prior run report",
  );
  assert.match(
    await page.locator("#assistant-report").textContent(),
    new RegExp(manifest.plan_sha256),
  );
  const beforeEdit = (await journal()).records.length;
  await page.locator("#assistant-validate").click();
  assert.equal(
    (await journal()).records.length,
    beforeEdit,
    "Editing and validating do not execute",
  );
  await page.locator("#assistant-run").click();
  await finished();
  const failure = await download(
    page.locator("#assistant-download-run"),
    "failed.json",
  );
  assert.equal(
    await page.locator("#assistant-report tbody tr").count(),
    0,
    "Starting a run clears stale report claims",
  );
  assert.equal(
    await page.locator("#assistant-report-create").isDisabled(),
    false,
  );
  await page.locator("#assistant-report-create").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#assistant-report-json").disabled ||
      document.querySelector("#assistant-status").classList.contains("error"),
  );
  assert.equal(
    await page.locator("#assistant-report-json").isDisabled(),
    false,
    await page.locator("#assistant-status").textContent(),
  );
  const failedReport = await download(
    page.locator("#assistant-report-json"),
    "failed-report.json",
  );
  assert.equal(failedReport.claims.length, 0);
  assert.ok(failedReport.warnings.some((w) => w.includes("failed")));
  assert.equal(failure.status, "failed");
  assert.deepEqual(
    failure.steps.map((s) => s.status),
    ["complete", "failed", "not_run"],
  );
  assert.match(failure.steps[1].error, /SHA-256 mismatch/);
  assert.match(
    await page.locator("#assistant-results").textContent(),
    /SHA-256 mismatch/,
  );
  const invalid = structuredClone(draft);
  invalid.steps[1].call.name = "unapproved";
  await page.locator("#assistant-plan").fill(JSON.stringify(invalid));
  const beforeInvalid = (await journal()).records.length;
  await page.locator("#assistant-validate").click();
  assert.match(
    await page.locator("#assistant-status").textContent(),
    /Validation failed/,
  );
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  assert.equal((await journal()).records.length, beforeInvalid);
  await page.locator("#assistant-measure").click();
  await page.locator("#assistant-validate").click();
  await page.evaluate(() => (globalThis.__assistantHold = true));
  await page.locator("#assistant-run").click();
  await page.waitForFunction(
    () => typeof globalThis.__assistantRelease === "function",
  );
  assert.equal(
    await page.locator("#assistant-report-create").isDisabled(),
    true,
  );
  assert.equal(await page.locator("#assistant-plan").isDisabled(), true);
  assert.equal(await page.locator("#assistant-refresh").isDisabled(), true);
  assert.equal(
    await page.locator("#preset").isDisabled(),
    false,
    "Interactive analysis stays available",
  );
  await page.locator("#assistant-cancel").click();
  await page.evaluate(() => {
    globalThis.__assistantHold = false;
    globalThis.__assistantRelease();
    globalThis.__assistantRelease = null;
  });
  await finished();
  const canceled = await download(
    page.locator("#assistant-download-run"),
    "canceled.json",
  );
  assert.equal(
    await page.locator("#assistant-report-create").isDisabled(),
    false,
  );
  await page.locator("#assistant-report-create").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#assistant-report-json").disabled ||
      document.querySelector("#assistant-status").classList.contains("error"),
  );
  assert.equal(
    await page.locator("#assistant-report-json").isDisabled(),
    false,
    await page.locator("#assistant-status").textContent(),
  );
  const canceledReport = await download(
    page.locator("#assistant-report-json"),
    "canceled-report.json",
  );
  assert.equal(canceledReport.claims.length, 0);
  assert.ok(canceledReport.warnings.some((w) => w.includes("not_run")));
  assert.equal(canceled.status, "canceled");
  assert.deepEqual(
    canceled.steps.map((s) => s.status),
    ["complete", "not_run", "not_run"],
  );
  await page.locator("#assistant-inspect").click();
  await run();
  assert.equal(
    (await download(page.locator("#assistant-download-run"), "inspect.json"))
      .steps.length,
    1,
  );
  await page.locator("#assistant-quality").click();
  await run();
  const quality = await download(
    page.locator("#assistant-download-run"),
    "quality.json",
  );
  assert.equal(quality.status, "complete");
  assert.equal(
    quality.steps[1].result.artifact.content.result.report.counts.total,
    160000,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.equal(await page.locator("#tab-assistant").isVisible(), true);
  await page.locator("#tab-assistant").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-measurements").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#tab-assistant").click();
  await page
    .locator(".assistant-advanced")
    .evaluate((node) => (node.open = false));
  await page
    .locator("#panel-assistant")
    .evaluate((node) => (node.scrollTop = 0));
  await page.screenshot({
    path: "/tmp/afm-assistant-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scratch,
        steps: manifest.steps.map((s) => s.status),
        replay_verified: replayed.replay_verified,
        output_sha256: analyzed.recipe.output.sha256,
        stale_source: failure.steps.map((s) => s.status),
        canceled: canceled.steps.map((s) => s.status),
        console_errors: errors,
        screenshots: [
          "/tmp/afm-assistant-desktop.png",
          "/tmp/afm-assistant-mobile.png",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
