/** Optional local browser batch QA. Requires an existing Playwright + Chromium installation. */
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
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const scratch = await mkdtemp(join(tmpdir(), "afm-batch-browser-"));
const raw = "sample-input.gwy",
  worked = "sample-reference.gwy",
  mismatch = "sample-other.gwy";
async function ready() {
  await page.waitForFunction(
    () =>
      document.querySelector("#status.error") ||
      !document.querySelector("#download").disabled,
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#status.error").count(),
    0,
    await page.locator("#status").textContent(),
  );
}
async function action(id) {
  await page.locator(id).click();
  await ready();
}
async function download(selector, name) {
  const event = page.waitForEvent("download");
  await (
    typeof selector === "string" ? page.locator(selector) : selector
  ).click();
  const file = await event;
  const path = join(scratch, name);
  await file.saveAs(path);
  return path;
}
function record(file) {
  return page.locator(".batch-record").filter({
    has: page.getByRole("heading", {
      name: new RegExp("^" + file.replaceAll(".", "\\.") + " · "),
    }),
  });
}
async function selectFiles(files) {
  for (const file of files)
    await page.locator("#batch-files input").evaluateAll((inputs, name) => {
      const input = inputs.find((input) => input.value === name);
      if (!input) throw new Error("Missing batch input " + name);
      input.click();
    }, file);
}
try {
  // Test-only response gate pauses one completed worker request before the queue advances.
  const source = await readFile(
    new URL("../web/api.js", import.meta.url),
    "utf8",
  );
  const gated =
    source.replace(
      "export async function apiFetch(",
      "async function internalApiFetch(",
    ) +
    '\nexport async function apiFetch(path,options={}) { const response=await internalApiFetch(path,options); if(path==="/api/batch-run"&&globalThis.__batchHold)await new Promise(resolve=>globalThis.__batchRelease=resolve); return response; }\n';
  await page.route("**/web/api.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: gated }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4174/web/");
  await ready();
  await page.waitForSelector("#batch-files input");
  await action("#preset");
  await page.locator("#batch-capture").click();
  const snapshot = await page.locator("#batch-template").textContent();
  assert.match(snapshot, /robust_plane/);
  await page.locator("#reset-selection").click();
  assert.equal(await page.locator("#batch-capture").isDisabled(), true);
  assert.equal(await page.locator("#batch-template").textContent(), snapshot);
  await action("#refresh");
  await action("#clear");
  assert.equal(await page.locator("#history li").count(), 0);
  assert.equal(await page.locator("#batch-template").textContent(), snapshot);
  await selectFiles([raw, mismatch, worked]);
  await page.locator("#batch-preflight").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#batch-status")
      .textContent.startsWith("Preflight complete"),
  );
  assert.equal(await record(raw).getAttribute("data-status"), "compatible");
  assert.equal(await record(worked).getAttribute("data-status"), "compatible");
  assert.equal(
    await record(mismatch).getAttribute("data-status"),
    "incompatible",
  );
  const mapBefore = await page
    .locator("#result")
    .evaluate((canvas) => canvas.toDataURL());
  const interactiveBefore = JSON.parse(
    await readFile(
      await download("#download", "interactive-before.json"),
      "utf8",
    ),
  );
  await page.evaluate(() => (globalThis.__batchHold = true));
  await page.locator("#batch-start").click();
  await page.waitForFunction(
    () => typeof globalThis.__batchRelease === "function",
  );
  assert.equal(
    await page
      .locator("#batch-files")
      .evaluate((fieldset) => fieldset.disabled),
    true,
  );
  for (const id of [
    "batch-capture",
    "batch-refresh",
    "batch-reset",
    "batch-preflight",
    "batch-start",
  ])
    assert.equal(await page.locator("#" + id).isDisabled(), true);
  await page.evaluate(() => {
    globalThis.__batchHold = false;
    globalThis.__batchRelease();
    globalThis.__batchRelease = null;
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#batch-status")
        .textContent.startsWith("Batch finished"),
    {},
    { timeout: 60000 },
  );
  const manifest = JSON.parse(
    await readFile(await download("#batch-download", "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.records.map((record) => record.status),
    ["complete", "failed", "complete"],
  );
  assert.equal(manifest.canceled, false);
  assert.match(manifest.template_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    manifest.template.operations.map((op) => op.name),
    ["robust_plane", "zero_min"],
  );
  assert.ok(manifest.records[0].result.warnings.length > 0);
  assert.match(await record(raw).textContent(), /Warnings:/);
  assert.equal(
    await page.locator("#result").evaluate((canvas) => canvas.toDataURL()),
    mapBefore,
  );
  const interactiveAfter = JSON.parse(
    await readFile(
      await download("#download", "interactive-after.json"),
      "utf8",
    ),
  );
  assert.equal(interactiveBefore.output.sha256, interactiveAfter.output.sha256);
  assert.deepEqual(interactiveAfter.operations, []);
  const recipePath = await download(
    record(raw).locator('[data-action="recipe"]'),
    "completed-recipe.json",
  );
  const recipe = JSON.parse(await readFile(recipePath, "utf8"));
  assert.equal(recipe.output.sha256, manifest.records[0].result.output_sha256);
  const tarPath = await download(
    record(raw).locator('[data-action="tar"]'),
    "verified.tar",
  );
  const tar = await readFile(tarPath);
  assert.equal(tar.subarray(257, 262).toString(), "ustar");
  assert.ok(tar.includes(Buffer.from(recipe.output.sha256)));
  await page.screenshot({ path: "/tmp/afm-browser-batch.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.locator("#upload").setInputFiles(recipePath);
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "Recipe replay complete.",
    {},
    { timeout: 60000 },
  );
  await page.locator("#compare").check();
  await ready();
  await page.locator("#batch-capture").click();
  assert.match(
    await page.locator("#batch-status").textContent(),
    /Reference-bearing recipes/,
  );
  assert.equal(await page.locator("#batch-template").textContent(), snapshot);
  await page.locator("#compare").uncheck();
  await ready();
  await page.locator("#batch-reset").click();
  await page.waitForSelector("#batch-files input");
  await page.locator("#batch-capture").click();
  await selectFiles([raw, worked]);
  const cancelSnapshot = await page.locator("#batch-template").textContent();
  await page.evaluate(() => (globalThis.__batchHold = true));
  await page.locator("#batch-start").click();
  await page.waitForFunction(
    () => typeof globalThis.__batchRelease === "function",
  );
  await action("#clear");
  assert.equal(
    await page.locator("#batch-template").textContent(),
    cancelSnapshot,
  );
  await page.locator("#batch-cancel").click();
  assert.match(
    await page.locator("#batch-status").textContent(),
    /current file finishes/,
  );
  await page.evaluate(() => {
    globalThis.__batchHold = false;
    globalThis.__batchRelease();
    globalThis.__batchRelease = null;
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#batch-status")
        .textContent.startsWith("Batch canceled"),
    {},
    { timeout: 60000 },
  );
  const canceled = JSON.parse(
    await readFile(await download("#batch-download", "canceled.json"), "utf8"),
  );
  assert.equal(canceled.canceled, true);
  assert.deepEqual(
    canceled.records.map((record) => record.status),
    ["complete", "not_run"],
  );
  assert.deepEqual(
    canceled.template.operations.map((op) => op.name),
    ["robust_plane", "zero_min"],
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scratch,
        template_sha256: manifest.template_sha256,
        records: manifest.records.map(({ file, status }) => ({ file, status })),
        canceled: canceled.records.map((record) => record.status),
        console_errors: errors,
        screenshot: "/tmp/afm-browser-batch.png",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
