/** Synthetic real-worker texture-domain capture and export regression. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine));
const browser = await pw[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
const scratch = await mkdtemp(join(tmpdir(), "afm-texture-domain-"));
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(gwy|spm|ibw|jpk)(\?|$)/, (r) => {
    errors.push("Repository measurement request");
    return r.abort();
  });
  const snapshot = () =>
    page.evaluate(async () => (await import("./app.js")).getAnalysisSnapshot());
  async function ready() {
    await page.waitForFunction(
      () =>
        !document.querySelector("#download").disabled ||
        document.querySelector("#status.error"),
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
  async function download(selector, name, json = true) {
    const event = page.waitForEvent("download");
    await page.locator(selector).click();
    const path = join(scratch, name);
    await (await event).saveAs(path);
    const bytes = await readFile(path);
    return json ? JSON.parse(bytes) : bytes;
  }
  let serial = 0;
  async function report() {
    return download("#texture-json", `report-${serial++}.json`);
  }
  async function capture(scope) {
    await page.locator("#tab-texture").click();
    await page.locator("#texture-scope").selectOption(scope);
    await page.locator("#texture-capture").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#texture-run").disabled ||
        document.querySelector("#texture-status.error"),
    );
    assert.equal(
      await page.locator("#texture-status.error").count(),
      0,
      await page.locator("#texture-status").textContent(),
    );
  }
  async function measure() {
    await page.locator("#texture-run").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#texture-json").disabled ||
        document.querySelector("#texture-status.error"),
    );
    assert.equal(
      await page.locator("#texture-status.error").count(),
      0,
      await page.locator("#texture-status").textContent(),
    );
    return report();
  }
  async function bounds(r) {
    assert.deepEqual(
      await page
        .locator("#texture-domain-map")
        .evaluate((e) => [
          JSON.parse(e.dataset.pixelBounds),
          JSON.parse(e.dataset.physicalBounds),
        ]),
      [r.domain.effective_pixel_bounds, r.domain.effective_physical_bounds],
    );
    assert.deepEqual(r.domain.effective_geometry, r.geometry);
    assert.match(
      await page.locator("#texture-domain").textContent(),
      /Measured rectangle/,
    );
  }
  async function roi(v) {
    await page.locator("#tab-measurements").click();
    if (!(await page.locator(".coordinate-panel").evaluate((e) => e.open)))
      await page.locator(".coordinate-panel > summary").click();
    for (const [i, k] of ["x0", "y0", "x1", "y1"].entries())
      await page.locator("#coord-" + k).fill(String(v[i]));
    await page.locator("#coordinate-roi").click();
    await page.locator("#refresh").click();
    await ready();
  }
  function tarReport(bytes) {
    for (let p = 0; p + 512 < bytes.length; ) {
      const h = bytes.subarray(p, p + 512),
        name = h.subarray(0, 100).toString().split("\0")[0];
      if (!name) break;
      const size = parseInt(
        h.subarray(124, 136).toString().replace(/\0/g, ""),
        8,
      );
      if (name === "report.json")
        return JSON.parse(bytes.subarray(p + 512, p + 512 + size));
      p += 512 + Math.ceil(size / 512) * 512;
    }
    throw Error("No report in TAR");
  }
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4191/web/");
  await load("texture-domain.gwy", createPreviewFixture());
  const original = await snapshot();
  await capture("full");
  let r = await measure();
  assert.equal(r.domain.kind, "full_processed_image");
  assert.deepEqual(r.domain.effective_pixel_bounds, [0, 0, 16, 16]);
  await bounds(r);
  assert.deepEqual(await snapshot(), original);
  await roi([2e-6, 1e-6, 6e-6, 3e-6]);
  const edgePolygon = [
    [0, 0],
    [0.5e-6, 0],
    [0.5e-6, 8e-6],
    [0, 8e-6],
  ];
  await page.locator("#coordinate-polygon").fill(JSON.stringify(edgePolygon));
  await page.locator("#coordinate-exclude").click();
  await page.locator("#operation").selectOption("plane");
  await page.locator("#add").click();
  await ready();
  const selected = await snapshot();
  assert.equal(selected.recipe.operations[0].name, "plane");
  assert.deepEqual(selected.recipe.selection.exclude_polygons, [edgePolygon]);
  await page.locator("#tab-texture").click();
  assert.deepEqual(
    await report(),
    r,
    "viewer selection does not alter captured result",
  );
  await capture("selection");
  r = await measure();
  assert.equal(r.domain.kind, "roi");
  assert.deepEqual(r.domain.effective_pixel_bounds, [4, 2, 12, 6]);
  assert.deepEqual(r.domain.requested_roi, selected.recipe.selection.roi);
  await bounds(r);
  assert.deepEqual(await snapshot(), selected);
  await page.screenshot({
    path: join(scratch, "texture-roi-desktop.png"),
    fullPage: true,
  });
  const expectedFull = await page.evaluate(async (recipe) => {
    const { apiFetch } = await import("./api.js");
    const response = await apiFetch("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        file: recipe.source.file,
        channel: Number(recipe.source.channel),
        operations: recipe.operations,
        selection: { ...recipe.selection, roi: null },
        profile: recipe.profile,
        plateaus: recipe.plateaus,
        reference: null,
      }),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, selected.recipe);
  assert.equal(
    expectedFull.recipe.output.sha256,
    selected.recipe.output.sha256,
    "Full measurement recapture preserves the plane fitted to its recorded selection",
  );
  assert.deepEqual(
    expectedFull.data,
    selected.data,
    "Measurement ROI does not refit the applied plane",
  );
  assert.deepEqual(expectedFull.recipe.operations, selected.recipe.operations);
  assert.deepEqual(
    selected.recipe.operations[0].selection,
    selected.recipe.selection,
    "Plane retains its original ROI and exclusions",
  );
  assert.notEqual(
    expectedFull.recipe.output.measurement_sha256,
    selected.recipe.output.measurement_sha256,
    "Measurement domain changes the measurement hash",
  );
  assert.deepEqual(
    await snapshot(),
    selected,
    "independent analysis leaves viewer unchanged",
  );
  await capture("full");
  r = await measure();
  assert.equal(r.domain.kind, "full_processed_image");
  assert.equal(r.input_recipe.selection.roi, null);
  assert.deepEqual(r.input_recipe.operations, selected.recipe.operations);
  assert.deepEqual(
    r.input_recipe.selection.exclude_polygons,
    selected.recipe.selection.exclude_polygons,
  );
  assert.deepEqual(r.domain.effective_pixel_bounds, [1, 0, 16, 16]);
  assert.deepEqual(
    r.input_recipe.output,
    expectedFull.recipe.output,
    "full capture exactly matches separate full-domain analysis",
  );
  assert.deepEqual(r.input_recipe.source, expectedFull.recipe.source);
  assert.deepEqual(r.input_recipe.selection, expectedFull.recipe.selection);
  assert.equal(r.domain.exclude_polygon_count, 1);
  assert.deepEqual(await snapshot(), selected);
  await bounds(r);
  await page.locator("#operation").selectOption("crop");
  await page.locator("#add").click();
  await ready();
  const cropped = await snapshot();
  assert.deepEqual(cropped.channel.shape, [4, 8]);
  await capture("full");
  r = await measure();
  assert.equal(r.domain.kind, "cropped_image");
  assert.deepEqual(r.domain.effective_pixel_bounds, [0, 0, 8, 4]);
  assert.deepEqual(
    r.domain.effective_physical_bounds,
    [2e-6, 1e-6, 6e-6, 3e-6],
  );
  assert.deepEqual(r.domain.processed_geometry, cropped.recipe.output.geometry);
  assert.deepEqual(r.input_recipe.operations, cropped.recipe.operations);
  assert.deepEqual(await snapshot(), cropped);
  await bounds(r);
  assert.deepEqual(
    tarReport(await download("#texture-tar", "domain.tar", false)),
    r,
  );
  // Nonfinite generated values exercise actual import/replay exclusion semantics.
  const edge = createPreviewFixture(),
    start = edge.indexOf(Buffer.from("data\0D")) + 10;
  assert.ok(start > 10);
  for (let y = 0; y < 16; y++) edge.writeDoubleLE(NaN, start + 8 * y * 16);
  await load("texture-edge.gwy", edge);
  await capture("full");
  r = await measure();
  assert.deepEqual(r.domain.effective_pixel_bounds, [1, 0, 16, 16]);
  assert.deepEqual(r.domain.effective_physical_bounds, [0.5e-6, 0, 8e-6, 8e-6]);
  await bounds(r);
  const hole = createPreviewFixture();
  hole.writeDoubleLE(NaN, start + 8 * (8 * 16 + 8));
  await load("texture-hole.gwy", hole);
  await capture("full");
  await page.locator("#texture-run").click();
  await page.waitForFunction(() =>
    document.querySelector("#texture-status.error"),
  );
  assert.match(
    await page.locator("#texture-status").textContent(),
    /missing|hole|invalid|rectangle/i,
  );
  assert.equal(await page.locator("#texture-json").isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browserEngine,
      scratch,
      checks: [
        "full/ROI/full capture",
        "immutable viewer and capture",
        "crop offset non-square",
        "JSON/TAR bounds",
        "invalid edge trim/internal hole rejection",
        "mobile",
      ],
    }),
  );
} finally {
  await browser.close();
}
