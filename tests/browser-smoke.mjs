/** Optional browser integration: start npm run dev first. No browser dependency is installed by this script. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const scratch = await mkdtemp(join(tmpdir(), "afm-browser-"));
async function ready() {
  await page.waitForFunction(
    () =>
      document.querySelector("#status.error") ||
      !document.querySelector("#download").disabled,
    {},
    { timeout: 30000 },
  );
  assert.equal(
    await page
      .locator("#status")
      .evaluate((el) => el.classList.contains("error")),
    false,
    await page.locator("#status").textContent(),
  );
}
async function action(selector) {
  await page.locator(selector).click();
  await ready();
}
async function download(selector, name) {
  const promise = page.waitForEvent("download");
  await page.locator(selector).click();
  const d = await promise;
  const path = join(scratch, name);
  await d.saveAs(path);
  return path;
}
try {
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4173/web/");
  await ready();
  assert.ok((await page.locator("#file option").count()) >= 5);
  assert.equal(
    await page.locator("#file").inputValue(),
    "sample-input.gwy",
  );
  assert.equal(await page.locator("#channel").inputValue(), "0");
  assert.equal(await page.locator("#histogram svg").count(), 1);
  assert.match(await page.locator("#raw-scale").textContent(), /[nµm]?m/);
  const calibration = JSON.parse(await page.locator("#metadata").textContent());
  // Original-source diagnostics must not mutate maps, source data, or pipeline.
  const originalRecipe = JSON.parse(
    await readFile(
      await download("#download", "before-quality-recipe.json"),
      "utf8",
    ),
  );
  const mapBefore = await page
    .locator("#result")
    .evaluate((canvas) => canvas.toDataURL());
  await page.locator("#tab-acquisition").click();
  assert.equal(await page.locator("#acquisition-reference").inputValue(), "");
  await page.locator("#acquisition-check").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#acquisition-status.error") ||
      !document.querySelector("#acquisition-export").disabled,
    {},
    { timeout: 30000 },
  );
  assert.equal(
    await page.locator("#acquisition-status.error").count(),
    0,
    await page.locator("#acquisition-status").textContent(),
  );
  const qualityFile = await download(
    "#acquisition-export",
    "acquisition-quality.json",
  );
  const qualityReport = JSON.parse(await readFile(qualityFile, "utf8"));
  assert.equal(qualityReport.input.sha256, originalRecipe.source.sha256);
  assert.match(qualityReport.code.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    qualityReport.reader_engine_sha256,
    originalRecipe.engine.sha256,
  );
  const qualitySources = await Promise.all(
    ["quality.js", "engine.js"].map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  assert.equal(
    qualityReport.code.sha256,
    createHash("sha256").update(qualitySources.join("\n")).digest("hex"),
  );
  assert.equal(qualityReport.input.reference_channel, null);
  assert.equal(qualityReport.report.comparison, null);
  assert.equal(qualityReport.report.counts.total, 160000);
  assert.equal(qualityReport.report.counts.selected, 160000);
  assert.ok(Array.isArray(qualityReport.report.rows.candidates));
  assert.ok(Array.isArray(qualityReport.report.columns.candidates));
  assert.equal(await page.locator("#history li").count(), 0);
  assert.equal(
    await page.locator("#result").evaluate((canvas) => canvas.toDataURL()),
    mapBefore,
  );
  const afterQuality = JSON.parse(
    await readFile(
      await download("#download", "after-quality-recipe.json"),
      "utf8",
    ),
  );
  assert.equal(afterQuality.output.sha256, originalRecipe.output.sha256);
  await page.locator("#acquisition-reference").selectOption("1");
  assert.equal(await page.locator("#acquisition-export").isDisabled(), true);
  await page.locator("#acquisition-check").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#acquisition-status.error") ||
      !document.querySelector("#acquisition-export").disabled,
  );
  assert.equal(await page.locator("#acquisition-status.error").count(), 0);
  const paired = JSON.parse(
    await readFile(
      await download("#acquisition-export", "paired-acquisition.json"),
      "utf8",
    ),
  );
  assert.equal(paired.input.reference_channel, "1");
  assert.ok(Number.isFinite(paired.report.comparison.rmse));
  await page.screenshot({ path: "/tmp/afm-quality-ui.png", fullPage: true });
  await page.locator("#acquisition-reference").selectOption("2");
  await page.locator("#acquisition-check").click();
  await page.waitForSelector("#acquisition-status.error");
  assert.equal(await page.locator("#acquisition-export").isDisabled(), true);
  assert.match(
    await page.locator("#acquisition-status").textContent(),
    /unit|geometry|compatible/i,
  );
  await page.locator("#acquisition-reference").selectOption("");
  await page.locator("#acquisition-check").click();
  await page.waitForFunction(
    () => !document.querySelector("#acquisition-export").disabled,
  );
  await page.locator("#tab-measurements").click();
  await action("#preset");
  assert.equal(await page.locator("#history li").count(), 2);
  await action("#chemist");
  await page.locator("#compare").check();
  await ready();
  assert.match(
    await page.locator("#comparison").textContent(),
    /Reference RMSE/,
  );
  await page.locator("#view").selectOption("difference");
  assert.equal(
    await page.locator("#result-title").textContent(),
    "Processed − reference",
  );
  await page.locator("#view").selectOption("processed");
  const replayFile = await download("#download", "chemist-recipe.json");
  const chemistRecipe = JSON.parse(await readFile(replayFile, "utf8"));
  assert.equal(chemistRecipe.operations[0].name, "three_point");
  const comparison = await page.evaluate(async (recipe) => {
    const { apiFetch } = await import("./api.js");
    const r = await apiFetch("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        file: recipe.source.file,
        channel: recipe.source.channel,
        operations: recipe.operations,
        selection: recipe.selection,
        reference: recipe.reference,
      }),
    });
    return (await r.json()).comparison;
  }, chemistRecipe);
  assert.ok(
    comparison.rmse < 1e-18,
    "Recorded chemist points reproduce the benchmark",
  );
  // Robust fit accepts arbitrary ROIs; recorded leveling points must stay selected.
  await action("#preset");
  // Pointer-driven ROI and line profile.
  await page.locator("#tool").selectOption("roi");
  await page.locator("#raw").scrollIntoViewIfNeeded();
  let b = await page.locator("#raw").boundingBox();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.7, {
    steps: 6,
  });
  await page.mouse.up();
  assert.match(await page.locator("#selection-info").textContent(), /ROI:/);
  assert.equal(await page.locator("#acquisition-export").isDisabled(), true);
  await action("#refresh");
  const selected = await download("#download", "roi-recipe.json");
  assert.ok(JSON.parse(await readFile(selected, "utf8")).selection.roi);
  await page.locator("#tool").selectOption("profile");
  await page.locator("#raw").scrollIntoViewIfNeeded();
  b = await page.locator("#raw").boundingBox();
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.6, {
    steps: 5,
  });
  await page.mouse.up();
  await action("#refresh");
  assert.equal(await page.locator("#profile svg").count(), 1);
  // Keyboard alternatives for exact selections and polygon exclusion.
  await page.locator(".coordinate-panel summary").click();
  const x0 = calibration.xoff + calibration.xreal * 0.3,
    y0 = calibration.yoff + calibration.yreal * 0.3,
    x1 = calibration.xoff + calibration.xreal * 0.7,
    y1 = calibration.yoff + calibration.yreal * 0.7;
  for (const [id, value] of Object.entries({
    "coord-x0": x0,
    "coord-y0": y0,
    "coord-x1": x1,
    "coord-y1": y1,
  }))
    await page.locator("#" + id).fill(String(value));
  await page.locator("#coordinate-roi").focus();
  await page.keyboard.press("Enter");
  await page.locator("#coordinate-profile").focus();
  await page.keyboard.press("Enter");
  const polygon = [
    [x0, y0],
    [x0 + (x1 - x0) * 0.2, y0],
    [x0, y0 + (y1 - y0) * 0.2],
  ];
  await page.locator("#coordinate-polygon").fill(JSON.stringify(polygon));
  await page.locator("#coordinate-exclude").focus();
  await page.keyboard.press("Enter");
  await action("#refresh");
  assert.match(
    await page.locator("#selection-info").textContent(),
    /1 excluded polygon/,
  );
  // Two independent physical plateau ROIs; the global ROI remains on B.
  for (const [index, fractions] of [
    [0, [0.05, 0.05, 0.2, 0.2]],
    [1, [0.45, 0.45, 0.55, 0.55]],
  ]) {
    const values = [
      calibration.xoff + calibration.xreal * fractions[0],
      calibration.yoff + calibration.yreal * fractions[1],
      calibration.xoff + calibration.xreal * fractions[2],
      calibration.yoff + calibration.yreal * fractions[3],
    ];
    for (const [i, id] of [
      "coord-x0",
      "coord-y0",
      "coord-x1",
      "coord-y1",
    ].entries())
      await page.locator("#" + id).fill(String(values[i]));
    await page.locator("#coordinate-roi").click();
    await page.locator(index ? "#plateau-b" : "#plateau-a").click();
  }
  await action("#refresh");
  assert.match(await page.locator("#step").textContent(), /Plateau A: mean/);
  assert.doesNotMatch(
    await page.locator("#step .step-height").textContent(),
    /—/,
  );
  assert.equal(await page.locator("#histogram svg rect").count(), 32);
  const selectionFile = await download("#download", "selection-recipe.json");
  const selectionRecipe = JSON.parse(await readFile(selectionFile, "utf8"));
  assert.equal(selectionRecipe.selection.exclude_polygons.length, 1);
  assert.equal(selectionRecipe.plateaus.length, 2);
  await page.locator("#upload").setInputFiles(selectionFile);
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "Recipe replay complete.",
    {},
    { timeout: 30000 },
  );
  assert.match(await page.locator("#step").textContent(), /Plateau B: mean/);
  const replayedFile = await download("#download", "replayed-recipe.json");
  assert.equal(
    JSON.parse(await readFile(replayedFile, "utf8")).output.sha256,
    selectionRecipe.output.sha256,
  );
  const tarFile = await download("#export", "analysis.tar");
  const tar = await readFile(tarFile);
  assert.equal(tar.subarray(257, 262).toString(), "ustar");
  assert.ok(tar.includes(Buffer.from("recipe.json")));
  await page.locator("#reset-selection").click(); // Reset invalidates the result until recalculated.
  await action("#refresh");
  await action("#preset");
  await page.locator(".coordinate-panel summary").click();
  await page.screenshot({
    path: process.env.AFM_SCREENSHOT || "/tmp/afm-ui-preview.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#result").scrollIntoViewIfNeeded();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile layout has no horizontal page overflow",
  );
  await page.screenshot({
    path: process.env.AFM_MOBILE_SCREENSHOT || "/tmp/afm-ui-mobile.png",
    fullPage: true,
  });
  await page.locator("#toggle-inspector").click();
  assert.equal(await page.locator("#data-inspector").isVisible(), true);
  // Local file import is exercised after benchmark evidence is saved.
  const local = await readFile(
    new URL("../data/sample-input.gwy", import.meta.url),
  );
  await page.locator("#import").setInputFiles({
    name: "local-import.gwy",
    mimeType: "application/octet-stream",
    buffer: local,
  });
  await page.waitForFunction(
    () => document.querySelector("#file").value === "local-import.gwy",
    {},
    { timeout: 30000 },
  );
  await ready();
  assert.equal(await page.locator("#chemist").isDisabled(), true);
  assert.equal(await page.locator("#compare").isChecked(), false);
  assert.equal(await page.locator("#view").inputValue(), "processed");
  // Arbitrary imported reference and deliberate reset on source switching.
  await page.locator("#reference-file").selectOption("local-import.gwy");
  await page.waitForFunction(
    () => !document.querySelector("#compare").disabled,
  );
  await page.locator("#compare").check();
  await ready();
  assert.match(
    await page.locator("#comparison").textContent(),
    /Reference RMSE: 0/,
  );
  const arbitrary = JSON.parse(
    await readFile(
      await download("#download", "arbitrary-reference.json"),
      "utf8",
    ),
  );
  assert.equal(arbitrary.reference.file, "local-import.gwy");
  await page.locator("#view").selectOption("difference");
  await page.locator("#file").selectOption("sample-input.gwy");
  await ready();
  assert.equal(await page.locator("#compare").isChecked(), false);
  assert.equal(await page.locator("#view").inputValue(), "processed");
  assert.equal(
    await page.locator("#reference-file").inputValue(),
    "local-import.gwy",
  );
  await page
    .locator("#upload")
    .setInputFiles(join(scratch, "arbitrary-reference.json"));
  await page.waitForFunction(
    () =>
      document.querySelector("#status").textContent ===
      "Recipe replay complete.",
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#reference-file").inputValue(),
    "local-import.gwy",
  );
  let nanoscope = {
    status: "skipped",
    reason: "Optional local reference fixture is absent",
  };
  const fixture = await readFile(
    new URL(
      "../data/external/reference-only/afmreader-sample_0.spm",
      import.meta.url,
    ),
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (fixture) {
    await page.setViewportSize({ width: 1440, height: 1080 });
    const started = performance.now();
    await page.locator("#import").setInputFiles({
      name: "nanoscope-reference.001",
      mimeType: "application/octet-stream",
      buffer: fixture,
    });
    await page.waitForFunction(
      () => document.querySelector("#file").value === "nanoscope-reference.001",
      {},
      { timeout: 60000 },
    );
    await ready();
    const elapsed = performance.now() - started;
    assert.match(
      await page.locator("#hover").textContent(),
      /Hover over either map/,
    );
    assert.equal(await page.locator("#channel option").count(), 8);
    assert.equal(await page.locator("#compare").isChecked(), false);
    assert.equal(await page.locator("#view").inputValue(), "processed");
    const heightId = await page
      .locator("#channel option")
      .evaluateAll(
        (options) =>
          options.find((option) => /height sensor/i.test(option.textContent))
            ?.value,
      );
    assert.ok(heightId, "Height Sensor channel is available");
    if ((await page.locator("#channel").inputValue()) !== heightId) {
      await page.locator("#channel").selectOption(heightId);
      await ready();
    }
    const nano = JSON.parse(await page.locator("#metadata").textContent());
    assert.deepEqual(nano.shape, [1024, 1024]);
    assert.equal(nano.z_unit, "m");
    assert.ok(Math.abs(nano.xreal - 505.859e-9) < 1e-15);
    await page.locator(".coordinate-panel summary").click();
    for (const [id, value] of Object.entries({
      "coord-x0": nano.xoff + nano.xreal * 0.2,
      "coord-y0": nano.yoff + nano.yreal * 0.5,
      "coord-x1": nano.xoff + nano.xreal * 0.8,
      "coord-y1": nano.yoff + nano.yreal * 0.5,
    }))
      await page.locator("#" + id).fill(String(value));
    await page.locator("#coordinate-profile").click();
    await action("#refresh");
    assert.equal(await page.locator("#profile svg").count(), 1);
    const nanoRecipe = await download("#download", "nanoscope-recipe.json");
    const nanoBefore = JSON.parse(await readFile(nanoRecipe, "utf8"));
    await page.locator("#upload").setInputFiles(nanoRecipe);
    await page.waitForFunction(
      () =>
        document.querySelector("#status").textContent ===
        "Recipe replay complete.",
      {},
      { timeout: 60000 },
    );
    const nanoAfter = JSON.parse(
      await readFile(
        await download("#download", "nanoscope-replayed.json"),
        "utf8",
      ),
    );
    assert.equal(nanoBefore.output.sha256, nanoAfter.output.sha256);
    await page.locator(".coordinate-panel summary").click();
    await page.screenshot({
      path: "/tmp/afm-nanoscope-ui.png",
      fullPage: true,
    });
    nanoscope = {
      status: "passed",
      import_and_first_analysis_ms: Math.round(elapsed),
      channels: 8,
      shape: nano.shape,
      xreal: nano.xreal,
      z_unit: nano.z_unit,
      screenshot: "/tmp/afm-nanoscope-ui.png",
    };
  }
  // Unsupported/malformed formats must be a visible error, without a page crash.
  for (const [name, bytes] of [
    ["invalid.ibw", [5, 0, 0, 0]],
    ["unsupported.tiff", [73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ]) {
    await page.locator("#import").setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(bytes),
    });
    await page.waitForSelector("#status.error");
    assert.match(
      await page.locator("#status").textContent(),
      /unsupported|not supported|invalid|truncated|header|short/i,
    );
  }
  let ibw = {
    status: "skipped",
    reason: "Optional local IBW reference fixture is absent",
  };
  const ibwFixture = await readFile(
    new URL(
      "../data/external/reference-only/afmreader-sample_0.ibw",
      import.meta.url,
    ),
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (ibwFixture) {
    const started = performance.now();
    await page.locator("#import").setInputFiles({
      name: "ibw-reference.ibw",
      mimeType: "application/octet-stream",
      buffer: ibwFixture,
    });
    await page.waitForFunction(
      () => document.querySelector("#file").value === "ibw-reference.ibw",
      {},
      { timeout: 60000 },
    );
    await ready();
    const elapsed = performance.now() - started;
    assert.equal(await page.locator("#channel option").count(), 8);
    const image = JSON.parse(await page.locator("#metadata").textContent());
    assert.equal(image.title, "HeightTrace");
    assert.deepEqual(image.shape, [512, 512]);
    assert.equal(image.z_unit, "m");
    assert.ok(Math.abs(image.xreal - 801.5655577299413e-9) < 1e-15);
    assert.match(await page.locator("#support-message").textContent(), /IBW/i);
    if (!(await page.locator(".coordinate-panel").evaluate((el) => el.open)))
      await page.locator(".coordinate-panel summary").click();
    for (const [id, value] of Object.entries({
      "coord-x0": image.xoff + image.xreal * 0.2,
      "coord-y0": image.yoff + image.yreal * 0.5,
      "coord-x1": image.xoff + image.xreal * 0.8,
      "coord-y1": image.yoff + image.yreal * 0.5,
    }))
      await page.locator("#" + id).fill(String(value));
    await page.locator("#coordinate-profile").click();
    await action("#refresh");
    assert.equal(await page.locator("#profile svg").count(), 1);
    const recipeFile = await download("#download", "ibw-recipe.json");
    const before = JSON.parse(await readFile(recipeFile, "utf8"));
    await page.locator("#upload").setInputFiles(recipeFile);
    await page.waitForFunction(
      () =>
        document.querySelector("#status").textContent ===
        "Recipe replay complete.",
      {},
      { timeout: 60000 },
    );
    const after = JSON.parse(
      await readFile(await download("#download", "ibw-replayed.json"), "utf8"),
    );
    assert.equal(before.output.sha256, after.output.sha256);
    assert.match(await page.locator("#support-message").textContent(), /IBW/i);
    await page.locator(".coordinate-panel summary").click();
    await page.screenshot({ path: "/tmp/afm-ibw-ui.png", fullPage: true });
    await page.locator("#channel").selectOption("2");
    await ready();
    assert.match(
      await page.locator("#support-title").textContent(),
      /Unverified configuration/,
    );
    assert.match(
      await page.locator("#support-message").textContent(),
      /unknown/i,
    );
    await page.screenshot({
      path: "/tmp/afm-ibw-unverified-ui.png",
      fullPage: true,
    });
    ibw = {
      status: "passed",
      import_and_first_analysis_ms: Math.round(elapsed),
      channels: 8,
      title: image.title,
      shape: image.shape,
      xreal: image.xreal,
      unknown_channel_warning: true,
      screenshot: "/tmp/afm-ibw-ui.png",
    };
  }
  let jpk = {
    status: "skipped",
    reason: "Optional local JPK reference fixture is absent",
  };
  const jpkFixture = await readFile(
    new URL(
      "../data/external/reference-only/afmreader-sample_0.jpk",
      import.meta.url,
    ),
  ).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (jpkFixture) {
    const started = performance.now();
    await page.locator("#import").setInputFiles({
      name: "jpk-reference.jpk",
      mimeType: "application/octet-stream",
      buffer: jpkFixture,
    });
    await page.waitForFunction(
      () => document.querySelector("#file").value === "jpk-reference.jpk",
      {},
      { timeout: 60000 },
    );
    await ready();
    const elapsed = performance.now() - started;
    assert.equal(await page.locator("#channel option").count(), 10);
    const image = JSON.parse(await page.locator("#metadata").textContent());
    assert.equal(String(image.id), "0");
    assert.equal(image.title, "height_retrace");
    assert.deepEqual(image.shape, [256, 256]);
    assert.equal(image.z_unit, "m");
    assert.ok(Math.abs(image.xreal - 326.91651420070083e-9) < 1e-15);
    assert.ok(Math.abs(image.yreal - 326.91651420070083e-9) < 1e-15);
    assert.match(
      await page.locator('#channel option[value="5"]').textContent(),
      /height_trace/,
    );
    assert.match(await page.locator("#support-message").textContent(), /JPK/i);
    assert.equal(
      await page.locator("#support-title").textContent(),
      "Validated import subset",
    );
    if (!(await page.locator(".coordinate-panel").evaluate((el) => el.open)))
      await page.locator(".coordinate-panel summary").click();
    for (const [id, value] of Object.entries({
      "coord-x0": image.xoff + image.xreal * 0.2,
      "coord-y0": image.yoff + image.yreal * 0.5,
      "coord-x1": image.xoff + image.xreal * 0.8,
      "coord-y1": image.yoff + image.yreal * 0.5,
    }))
      await page.locator("#" + id).fill(String(value));
    await page.locator("#coordinate-profile").click();
    await action("#refresh");
    assert.equal(await page.locator("#profile svg").count(), 1);
    const recipeFile = await download("#download", "jpk-recipe.json");
    const before = JSON.parse(await readFile(recipeFile, "utf8"));
    await page.locator("#upload").setInputFiles(recipeFile);
    await page.waitForFunction(
      () =>
        document.querySelector("#status").textContent ===
        "Recipe replay complete.",
      {},
      { timeout: 60000 },
    );
    const after = JSON.parse(
      await readFile(await download("#download", "jpk-replayed.json"), "utf8"),
    );
    assert.equal(before.output.sha256, after.output.sha256);
    await page.locator(".coordinate-panel summary").click();
    await page.screenshot({ path: "/tmp/afm-jpk-ui.png", fullPage: true });
    await page.locator("#channel").selectOption("3");
    await ready();
    const phase = JSON.parse(await page.locator("#metadata").textContent());
    assert.equal(phase.title, "phase_retrace");
    assert.equal(phase.z_unit, "deg");
    assert.match(await page.locator("#raw-scale").textContent(), /deg/);
    await page.locator("#channel").selectOption("4");
    await ready();
    const errorChannel = JSON.parse(
      await page.locator("#metadata").textContent(),
    );
    assert.equal(errorChannel.title, "error_retrace");
    assert.equal(errorChannel.z_unit, "V");
    // Mutate only declared JPK software-version-tag ASCII bytes, never image strips.
    const modified = Buffer.from(jpkFixture),
      little = modified.toString("ascii", 0, 2) === "II";
    const u16 = (offset) =>
        little ? modified.readUInt16LE(offset) : modified.readUInt16BE(offset),
      u32 = (offset) =>
        little ? modified.readUInt32LE(offset) : modified.readUInt32BE(offset);
    let ifd = u32(4),
      replacements = 0;
    const seen = new Set();
    while (ifd && !seen.has(ifd)) {
      seen.add(ifd);
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + 12 * i;
        if (u16(entry) !== 0x8000 || u16(entry + 2) !== 2) continue;
        const length = u32(entry + 4),
          offset = length <= 4 ? entry + 8 : u32(entry + 8);
        const index = modified
          .subarray(offset, offset + length)
          .indexOf(Buffer.from("6.0.41"));
        if (index >= 0) {
          modified.write("6.0.42", offset + index, "ascii");
          replacements++;
        }
      }
      ifd = u32(ifd + 2 + 12 * count);
    }
    assert.ok(replacements > 0, "Software configuration tag was identified");
    await page.locator("#import").setInputFiles({
      name: "jpk-unverified-config.jpk",
      mimeType: "application/octet-stream",
      buffer: modified,
    });
    await page.waitForFunction(
      () =>
        document.querySelector("#file").value === "jpk-unverified-config.jpk",
      {},
      { timeout: 60000 },
    );
    await ready();
    assert.equal(
      await page.locator("#support-title").textContent(),
      "Unverified configuration",
    );
    const mutated = JSON.parse(
      await readFile(
        await download("#download", "jpk-unverified-recipe.json"),
        "utf8",
      ),
    );
    assert.equal(
      mutated.output.sha256,
      before.output.sha256,
      "Software-only mutation preserves calibrated image values",
    );
    const altered = JSON.parse(await page.locator("#metadata").textContent());
    assert.equal(altered.xreal, image.xreal);
    assert.equal(altered.yreal, image.yreal);
    await page.screenshot({
      path: "/tmp/afm-jpk-unverified-ui.png",
      fullPage: true,
    });
    jpk = {
      status: "passed",
      import_and_first_analysis_ms: Math.round(elapsed),
      channels: 10,
      title: image.title,
      shape: image.shape,
      xreal: image.xreal,
      phase_unit: phase.z_unit,
      error_unit: errorChannel.z_unit,
      unverified_configuration_warning: true,
      screenshot: "/tmp/afm-jpk-ui.png",
    };
  }
  const emptyPage = await browser.newPage();
  await emptyPage.route("**/data/manifest.json", (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await emptyPage.goto(
    process.env.AFM_BASE_URL || "http://127.0.0.1:4173/web/",
  );
  await emptyPage.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  await emptyPage.locator("#import").setInputFiles({
    name: "standalone.001",
    mimeType: "application/octet-stream",
    buffer: local,
  });
  await emptyPage.waitForFunction(
    () =>
      document.querySelector("#file").value === "standalone.001" &&
      !document.querySelector("#download").disabled,
    {},
    { timeout: 60000 },
  );
  assert.equal(await emptyPage.locator("#status.error").count(), 0);
  await emptyPage.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        rmse: comparison.rmse,
        quality_code_sha256: qualityReport.code.sha256,
        quality_source_sha256: qualityReport.input.sha256,
        recipe_sha256: selectionRecipe.output.sha256,
        scratch,
        screenshot: process.env.AFM_SCREENSHOT || "/tmp/afm-ui-preview.png",
        console_errors: errors,
        nanoscope,
        ibw,
        jpk,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
