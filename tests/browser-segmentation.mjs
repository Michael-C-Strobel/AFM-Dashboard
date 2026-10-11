/** Optional synthetic browser segmentation QA; no external measurement fixtures required. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
const scratch = await mkdtemp(join(tmpdir(), "afm-segmentation-browser-"));
const str = (v) => Buffer.concat([Buffer.from(v), Buffer.from([0])]);
function uint(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function item(key, type, value) {
  let p;
  if (type === "o") p = value;
  else if (type === "s") p = str(value);
  else if (type === "D") {
    const b = Buffer.alloc(value.length * 8);
    value.forEach((v, i) => b.writeDoubleLE(v, i * 8));
    p = Buffer.concat([uint(value.length), b]);
  } else {
    p = Buffer.alloc(type === "d" ? 8 : 4);
    type === "d" ? p.writeDoubleLE(value) : p.writeInt32LE(value);
  }
  return Buffer.concat([str(key), Buffer.from(type), p]);
}
function object(name, ...parts) {
  const b = Buffer.concat(parts);
  return Buffer.concat([str(name), uint(b.length), b]);
}
function fixture(values, mask = null, width = 3, height = 2) {
  const field = (values) =>
    object(
      "GwyDataField",
      item("xres", "i", width),
      item("yres", "i", height),
      item("xreal", "d", width * 1e-6),
      item("yreal", "d", height * 1e-6),
      item("data", "D", values),
      ...["si_unit_xy", "si_unit_z"].map((k) =>
        item(k, "o", object("GwySIUnit", item("unitstr", "s", "m"))),
      ),
    );
  return Buffer.concat([
    Buffer.from("GWYP"),
    object(
      "GwyContainer",
      item("/0/data", "o", field(values)),
      item("/0/data/title", "s", "Synthetic height"),
      ...(mask ? [item("/0/mask", "o", field(mask))] : []),
    ),
  ]);
}
async function ready() {
  await page.waitForFunction(
    () =>
      !document.querySelector("#download").disabled ||
      document.querySelector("#status.error"),
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#status.error").count(),
    0,
    await page.locator("#status").textContent(),
  );
}
async function load(name, buffer) {
  await page
    .locator("#import")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await page.waitForFunction(
    (name) => document.querySelector("#file").value === name,
    name,
  );
  await ready();
}
async function segment(threshold = "3e-9") {
  await page.locator("#features-threshold").fill(threshold);
  await page.locator("#features-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#features-json").disabled ||
      document.querySelector("#features-status.error"),
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#features-status.error").count(),
    0,
    await page.locator("#features-status").textContent(),
  );
}
async function download(selector, name, json = true) {
  const event = page.waitForEvent("download");
  await page.locator(selector).click();
  const path = join(scratch, name);
  await (await event).saveAs(path);
  const value = await readFile(path, "utf8");
  return json ? JSON.parse(value) : value;
}
try {
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4174/web/");
  await load("synthetic.gwy", fixture([0, 1, 2, 3, 4, 5].map((x) => x * 1e-9)));
  const before = await page
    .locator("#raw,#result")
    .evaluateAll((cs) => cs.map((c) => c.toDataURL()));
  await page.locator("#tab-assistant").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-features").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#features-capture").click();
  assert.equal(await page.locator("#features-threshold").inputValue(), "");
  await page.locator("#features-run").click();
  assert.match(
    await page.locator("#features-status").textContent(),
    /explicitly/,
  );
  await segment();
  const result = await download("#features-json", "segmentation.json");
  assert.equal(result.kind, "segmentation");
  assert.equal(result.report.counts.accepted_pixels, 3);
  assert.equal(result.report.regions.length, 1);
  const region = result.report.regions[0];
  assert.equal(region.pixel_count, 3);
  assert.ok(Math.abs(region.area - 3e-12) < 1e-24);
  assert.ok(Math.abs(region.width - 3e-6) < 1e-18);
  assert.ok(Math.abs(region.height - 1e-6) < 1e-18);
  assert.equal(region.area_unit, "(m)²");
  assert.equal(result.report.geometry.z_unit, "m");
  assert.match(result.labels_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.report_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.code.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.labels.slice(0, 3), [0, 0, 0]);
  assert.ok(result.labels.slice(3).every((x) => x === region.id));
  assert.deepEqual(
    await page
      .locator("#raw,#result")
      .evaluateAll((cs) => cs.map((c) => c.toDataURL())),
    before,
    "Segmentation does not mutate the main maps",
  );
  await page.locator("#features-rows button").first().click();
  assert.equal(
    await page
      .locator("#features-rows button")
      .first()
      .getAttribute("aria-pressed"),
    "true",
  );
  const tsv = await download("#features-tsv", "regions.tsv", false);
  assert.ok(tsv.includes(result.report_sha256));
  assert.ok(tsv.includes(result.input_recipe.source.sha256));
  assert.match(tsv, /area_unit/);
  // A dirty main viewer cannot replace the captured source.
  await page.locator("#reset-selection").click();
  await page.locator("#features-capture").click();
  assert.match(
    await page.locator("#features-status").textContent(),
    /Capture refused/,
  );
  assert.equal(await page.locator("#features-json").isDisabled(), false);
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  await segment();
  const independent = await download("#features-json", "independent.json");
  assert.equal(
    independent.input_recipe.output.sha256,
    result.input_recipe.output.sha256,
  );
  await page.locator("#features-capture").click();
  assert.equal(await page.locator("#features-json").isDisabled(), true);
  assert.equal(await page.locator("#features-threshold").inputValue(), "");
  await segment("0");
  const processed = await download("#features-json", "processed.json");
  assert.equal(processed.input_recipe.operations.at(-1).name, "mean");
  assert.notEqual(
    processed.input_recipe.output.sha256,
    result.input_recipe.output.sha256,
  );
  await load("diagonal.gwy", fixture([4, 0, 4, 0, 4, 0].map((x) => x * 1e-9)));
  await page.locator("#features-capture").click();
  await segment();
  assert.equal(
    (await download("#features-json", "four.json")).report.regions.length,
    3,
  );
  await page.locator("#features-connectivity").selectOption("8");
  assert.equal(await page.locator("#features-json").isDisabled(), true);
  await segment();
  assert.equal(
    (await download("#features-json", "eight.json")).report.regions.length,
    1,
  );
  await page.locator("#features-boundary").selectOption("exclude");
  await segment();
  const excluded = await download("#features-json", "excluded.json");
  assert.equal(excluded.report.regions.length, 0);
  assert.equal(excluded.report.excluded_regions.length, 1);
  await page.locator("#features-excluded").check();
  assert.equal(await page.locator("#features-rows tr").count(), 1);
  assert.match(
    await page.locator("#features-rows").textContent(),
    /image_boundary/,
  );
  // Source-mask nulls and finite ROI-excluded cells stay distinct in the dedicated preview.
  await load(
    "masked.gwy",
    fixture(
      [0, 1, 2, 3, 4, 5].map((x) => x * 1e-9),
      [0, 0, 0, 0, 1, 0],
    ),
  );
  await page.locator("#features-boundary").selectOption("include");
  await page.locator("#features-connectivity").selectOption("4");
  await page.locator("#features-capture").click();
  await segment();
  const masked = await download("#features-json", "masked.json");
  assert.equal(masked.report.counts.accepted_pixels, 2);
  assert.equal(masked.report.regions.length, 2);
  assert.match(
    await page.locator("#features-legend").textContent(),
    /missing.source-masked/,
  );
  await page.locator("#tab-measurements").click();
  await page.locator(".coordinate-panel summary").click();
  for (const [id, value] of Object.entries({
    "coord-x0": "0",
    "coord-y0": "0",
    "coord-x1": "2e-6",
    "coord-y1": "2e-6",
  }))
    await page.locator("#" + id).fill(value);
  await page.locator("#coordinate-roi").click();
  await page.locator("#refresh").click();
  await ready();
  await page.locator("#tab-features").click();
  await page.locator("#features-capture").click();
  await segment();
  const roi = await download("#features-json", "roi.json");
  assert.deepEqual(roi.input_recipe.selection.roi, [0, 0, 2e-6, 2e-6]);
  assert.equal(roi.report.counts.accepted_pixels, 1);
  await page.locator("#panel-features").evaluate((n) => (n.scrollTop = 0));
  await page.screenshot({ path: "/tmp/afm-features-desktop.png" });
  // More than 500 disconnected components render in bounded pages; exports stay complete.
  const width = 34,
    height = 34,
    values = Array.from({ length: width * height }, (_, i) =>
      (Math.floor(i / width) + (i % width)) % 2 ? 0 : 4e-9,
    );
  await load("many-regions.gwy", fixture(values, null, width, height));
  await page.locator("#features-capture").click();
  await segment();
  const many = await download("#features-json", "many.json");
  assert.equal(many.report.regions.length, 578);
  assert.equal(await page.locator("#features-rows tr").count(), 100);
  await page.locator("#features-next").click();
  assert.equal(await page.locator("#features-rows tr").count(), 100);
  assert.match(await page.locator("#features-counts").textContent(), /101–200/);
  assert.equal(
    (await download("#features-tsv", "many.tsv", false)).trim().split("\n")
      .length,
    579,
  );
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No horizontal overflow at " + width,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.locator("#features-canvas").scrollIntoViewIfNeeded();
  const preview = await page.locator("#features-canvas").boundingBox();
  assert.ok(preview.width > 200 && preview.height >= 200);
  await page.screenshot({
    path: "/tmp/afm-features-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        scratch,
        accepted_pixels: region.pixel_count,
        area: region.area,
        connectivity: "4 and 8",
        source_masks: true,
        roi: true,
        paginated_regions: many.report.regions.length,
        console_errors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
