/** Synthetic browser integration. Owns its server on port 4175 and temporary files. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
function fixture(offset = 0, unit = "m") {
  const string = (text) => Buffer.from(text + "\0");
  const uint = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const item = (name, type, payload) =>
    Buffer.concat([string(name), Buffer.from(type), payload]);
  const object = (name, fields) => {
    const bytes = Buffer.concat(fields);
    return Buffer.concat([string(name), uint(bytes.length), bytes]);
  };
  const double = (n) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return b;
  };
  const field = object("GwyDataField", [
    item("xres", "i", uint(3)),
    item("yres", "i", uint(2)),
    item("xreal", "d", double(3e-6)),
    item("yreal", "d", double(2e-6)),
    item(
      "si_unit_xy",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string("m"))]),
    ),
    item(
      "si_unit_z",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string(unit))]),
    ),
    item(
      "data",
      "D",
      Buffer.concat([
        uint(6),
        ...[0, 1, 2, 3, 4, 5].map((n) => double(n * 1e-9 + offset)),
      ]),
    ),
  ]);
  return Buffer.concat([
    Buffer.from("GWYP"),
    object("GwyContainer", [
      item("/0/data", "o", field),
      item("/0/data/title", "s", string("Height_Trace")),
    ]),
  ]);
}
const scratch = await mkdtemp(join(tmpdir(), "afm-browser-ci-"));
let browser, server;
let serverOutput = "";
const errors = [];
const near = (actual, expected, tolerance = 1e-20) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
try {
  const bytes = fixture();
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const sourcePath = join(scratch, "synthetic.gwy");
  await writeFile(sourcePath, bytes);
  server = spawn(
    process.execPath,
    [fileURLToPath(new URL("../scripts/serve.mjs", import.meta.url))],
    {
      env: { ...process.env, PORT: "4175", AFM_LIVE_RELOAD: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server start timed out: ${serverOutput}`)),
      10000,
    );
    const failed = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    server.once("error", failed);
    server.once("exit", (code) =>
      failed(new Error(`Owned server exited ${code}: ${serverOutput}`)),
    );
    server.stderr.on("data", (chunk) => {
      serverOutput += chunk;
    });
    server.stdout.on("data", (chunk) => {
      serverOutput += chunk;
      if (serverOutput.includes("AFM Dashboard:")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ files: [] }),
    }),
  );
  // Any attempted sample load is a failure: only generated input is permitted.
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (route) => {
    errors.push(
      `Unexpected repository sample request: ${route.request().url()}`,
    );
    return route.abort();
  });
  await page.goto("http://127.0.0.1:4175/web/");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  assert.equal(await page.locator("#file option").count(), 0);
  await page.locator("#import").setInputFiles(sourcePath);
  async function ready() {
    await page.waitForFunction(
      () =>
        document.querySelector("#status.error") ||
        !document.querySelector("#download").disabled,
    );
    assert.equal(
      await page.locator("#status.error").count(),
      0,
      await page.locator("#status").textContent(),
    );
  }
  async function download(selector, name) {
    const event = page.waitForEvent("download");
    await page.locator(selector).click();
    const path = join(scratch, name);
    await (await event).saveAs(path);
    return { path, value: JSON.parse(await readFile(path, "utf8")) };
  }
  async function replay(recipe) {
    return page.evaluate(async (recipe) => {
      const { apiFetch } = await import("./api.js");
      const response = await apiFetch("/api/replay", {
        method: "POST",
        body: JSON.stringify({ recipe }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    }, recipe);
  }
  await ready();
  const initial = (await download("#download", "original-recipe.json")).value;
  assert.equal(initial.source.sha256, sourceHash);
  assert.deepEqual(initial.source.geometry.shape, [2, 3]);
  assert.equal(initial.source.geometry.xy_unit, "m");
  assert.equal(initial.source.geometry.z_unit, "m");
  near(initial.source.geometry.xreal, 3e-6);
  near(initial.source.geometry.yreal, 2e-6);
  const calibration = JSON.parse(await page.locator("#metadata").textContent());
  assert.deepEqual(calibration.shape, [2, 3]);
  assert.equal(calibration.xy_unit, "m");
  const original = await replay(initial);
  assert.equal(original.replay_verified, true);
  assert.equal(original.statistics.valid_count, 6);
  near(original.statistics.mean, 2.5e-9);
  near(original.statistics.sa, 1.5e-9);
  near(original.statistics.sq, Math.sqrt(35 / 12) * 1e-9);
  near(original.statistics.min, 0);
  near(original.statistics.max, 5e-9);
  near(original.statistics.area, 6e-12);
  assert.match(await page.locator("#statistics").textContent(), /1\.5/);
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  assert.equal(await page.locator("#history li").count(), 1);
  const processedDownload = await download(
    "#download",
    "processed-recipe.json",
  );
  const processed = processedDownload.value;
  assert.equal(processed.operations[0].name, "mean");
  assert.notEqual(processed.output.sha256, initial.output.sha256);
  const processedResult = await replay(processed);
  near(processedResult.statistics.mean, 0);
  near(processedResult.statistics.sa, 1.5e-9);
  assert.equal(processedResult.recipe.output.sha256, processed.output.sha256);
  // Replay the downloaded recipe through the actual file input as well.
  await page.locator("#upload").setInputFiles(processedDownload.path);
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Recipe replay complete"),
  );
  const restored = (await download("#download", "restored-recipe.json")).value;
  assert.equal(restored.output.sha256, processed.output.sha256);
  assert.equal(
    restored.output.measurement_sha256,
    processed.output.measurement_sha256,
  );
  await page.locator("#tab-batch").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-assistant").getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.locator("#panel-assistant").isVisible(), true);
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  await page.locator("#assistant-replay").check();
  await page.locator("#assistant-measure").click();
  const draft = JSON.parse(await page.locator("#assistant-plan").inputValue());
  assert.deepEqual(
    draft.steps.map((step) => step.call.name),
    ["inspect_source", "analyze_surface", "replay_recipe"],
  );
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  await page.locator("#assistant-validate").click();
  assert.equal(await page.locator("#assistant-run").isDisabled(), false);
  await page.locator("#assistant-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#assistant-download-run").disabled &&
      !document.querySelector("#assistant-validate").disabled,
  );
  const manifest = (await download("#assistant-download-run", "run.json"))
    .value;
  assert.equal(manifest.status, "complete");
  assert.deepEqual(
    manifest.steps.map((step) => step.status),
    ["complete", "complete", "complete"],
  );
  const analyzed = manifest.steps[1].result.artifact.content.result;
  const replayed = manifest.steps[2].result.artifact.content.result;
  assert.equal(analyzed.recipe.source.sha256, sourceHash);
  assert.equal(analyzed.recipe.output.sha256, initial.output.sha256);
  assert.equal(replayed.replay_verified, true);
  assert.deepEqual(replayed.recipe.output, analyzed.recipe.output);
  near(analyzed.statistics.mean, 2.5e-9);
  assert.equal(
    manifest.steps[2].resolved_call.arguments.recipe_artifact,
    manifest.steps[1].result.artifact.id,
  );
  await page.locator("#tab-features").click();
  await page.locator("#features-capture").click();
  await page.locator("#features-threshold").fill("0");
  await page.locator("#features-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#features-json").disabled ||
      document.querySelector("#features-status.error"),
  );
  assert.equal(
    await page.locator("#features-status.error").count(),
    0,
    await page.locator("#features-status").textContent(),
  );
  const segmented = (await download("#features-json", "segmentation.json"))
    .value;
  assert.equal(segmented.input_recipe.output.sha256, restored.output.sha256);
  assert.equal(segmented.report.counts.accepted_pixels, 3);
  near(segmented.report.regions[0].area, 3e-12);
  assert.deepEqual(segmented.labels, [0, 0, 0, 1, 1, 1]);
  await page.locator("#tab-texture").click();
  await page.locator("#texture-capture").click();
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
  const texture = (await download("#texture-json", "texture.json")).value;
  assert.equal(texture.input_recipe.output.sha256, restored.output.sha256);
  assert.equal(texture.kind, "spatial_texture");
  near(texture.psd.integral, texture.psd.expected_mean_square, 1e-30);
  assert.equal(texture.acf.overview.width, 5);
  await page.locator("#tab-registration").click();
  await page.locator("#registration-capture-fixed").click();
  await page.locator("#registration-capture-moving").click();
  await page.locator("#registration-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#registration-json").disabled ||
      document.querySelector("#registration-status.error"),
  );
  assert.equal(
    await page.locator("#registration-status.error").count(),
    0,
    await page.locator("#registration-status").textContent(),
  );
  const registration = (
    await download("#registration-json", "registration.json")
  ).value;
  assert.equal(registration.kind, "translation_registration");
  assert.equal(registration.metrics.rmse, 0);
  assert.equal(registration.metrics.valid_count, 6);
  assert.equal(
    registration.input_recipes.fixed.output.sha256,
    restored.output.sha256,
  );
  assert.deepEqual(
    registration.input_recipes.fixed,
    registration.input_recipes.moving,
  );
  await page.locator("#tab-sensitivity").click();
  await page.locator("#sensitivity-capture").click();
  await page.locator("#sensitivity-add-mean").click();
  await page.locator("#sensitivity-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#sensitivity-json").disabled ||
      document.querySelector("#sensitivity-status.error"),
  );
  assert.equal(
    await page.locator("#sensitivity-status.error").count(),
    0,
    await page.locator("#sensitivity-status").textContent(),
  );
  const sensitivity = (await download("#sensitivity-json", "sensitivity.json"))
    .value;
  assert.equal(sensitivity.kind, "analysis_sensitivity");
  assert.equal(sensitivity.status, "complete");
  assert.equal(
    sensitivity.baseline.recipe.output.sha256,
    restored.output.sha256,
  );
  assert.equal(sensitivity.variants.length, 1);
  assert.equal(sensitivity.variants[0].status, "succeeded");
  assert.equal(sensitivity.calibration_uncertainty.status, "not_evaluated");
  await page.locator("#expand-inspection").click();
  assert.equal(
    await page.locator("#inspection-dialog").evaluate((node) => node.open),
    true,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#inspection-dialog").open,
  );
  assert.equal(
    await page
      .locator("#expand-inspection")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile document overflows horizontally",
  );
  await page.locator("#tab-assistant").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-features").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-texture").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-registration").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-sensitivity").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-measurements").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#tab-assistant").click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        fixture: "synthetic GWYP 3x2",
        source_sha256: sourceHash,
        replay_verified: replayed.replay_verified,
        browser: await browser.version(),
        checks: [
          "UI import",
          "calibrated statistics",
          "operation",
          "recipe download/upload/replay",
          "Assistant strict replay",
          "captured processed segmentation",
          "captured processed spatial texture",
          "dual-recipe registration",
          "captured sensitivity alternatives",
          "expanded inspection and Escape",
          "keyboard tabs",
          "mobile overflow",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (
        server?.pid &&
        server.exitCode === null &&
        server.signalCode === null
      ) {
        const exited = once(server, "exit");
        server.kill("SIGTERM");
        const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
