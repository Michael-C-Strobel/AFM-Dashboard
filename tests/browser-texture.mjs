/** Optional synthetic browser spatial-texture QA; no external measurement fixtures required. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const scratch = await mkdtemp(join(tmpdir(), "afm-texture-browser-"));
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

const digest = (v) => createHash("sha256").update(v).digest("hex");
async function measure() {
  await page.locator("#texture-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#texture-json").disabled ||
      document.querySelector("#texture-status.error"),
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#texture-status.error").count(),
    0,
    await page.locator("#texture-status").textContent(),
  );
}
async function download(selector, name, json = true) {
  const event = page.waitForEvent("download");
  await page.locator(selector).click();
  const path = join(scratch, name);
  await (await event).saveAs(path);
  const bytes = await readFile(path);
  return json ? JSON.parse(bytes) : bytes;
}
function tarFiles(bytes) {
  const entries = {};
  for (let offset = 0; offset < bytes.length - 1024; ) {
    const header = bytes.subarray(offset, offset + 512),
      name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
      header.subarray(124, 136).toString().replace(/\0/g, ""),
      8,
    );
    entries[name] = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
const maps = () =>
  page
    .locator("#raw,#result")
    .evaluateAll((cs) => cs.map((c) => c.toDataURL()));
try {
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/");
  const values = Array.from(
    { length: 32 },
    (_, i) => 2e-9 * Math.cos((2 * Math.PI * (i % 8)) / 4),
  );
  await load("waves.gwy", fixture(values, null, 8, 4));
  const before = await maps();
  await page.locator("#tab-features").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-texture").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#texture-capture").click();
  await measure();
  const report = await download("#texture-json", "texture.json");
  assert.equal(report.kind, "spatial_texture");
  assert.equal(report.parameters.detrend, "mean");
  assert.equal(report.parameters.window, "boxcar");
  assert.equal(report.arrays.psd.width, 16);
  assert.equal(report.arrays.psd.height, 8);
  assert.ok(Math.abs(report.psd.integral - 2e-18) < 1e-30);
  assert.ok(Math.abs(report.acf.zero_lag - 2e-18) < 1e-30);
  const unsigned = structuredClone(report);
  delete unsigned.report_sha256;
  assert.equal(digest(JSON.stringify(unsigned)), report.report_sha256);
  assert.deepEqual(
    await maps(),
    before,
    "Texture must not alter main scan maps",
  );
  const entries = tarFiles(
    await download("#texture-tar", "texture.tar", false),
  );
  assert.deepEqual(JSON.parse(entries["report.json"]), report);
  assert.deepEqual(
    JSON.parse(entries["input-recipe.json"]),
    report.input_recipe,
  );
  for (const metadata of Object.values(report.arrays))
    if (metadata) {
      assert.equal(digest(entries[metadata.file]), metadata.sha256);
      assert.equal(
        entries[metadata.file].length,
        metadata.width * metadata.height * 8,
      );
    }
  const psd = entries["psd.f64"],
    meta = report.arrays.psd;
  const zeroY = Math.round(-meta.y_axis.start / meta.y_axis.step);
  const plusX = Math.round((250000 - meta.x_axis.start) / meta.x_axis.step);
  const minusX = Math.round((-250000 - meta.x_axis.start) / meta.x_axis.step);
  const plus = psd.readDoubleLE(8 * (zeroY * meta.width + plusX));
  const minus = psd.readDoubleLE(8 * (zeroY * meta.width + minusX));
  assert.ok(Math.abs(plus - 3.2e-29) < 1e-40);
  assert.ok(Math.abs(plus - minus) < 1e-40);
  await page.locator("#texture-log").uncheck();
  await page.locator("#texture-normalized").check();
  assert.deepEqual(
    await download("#texture-json", "display-only.json"),
    report,
    "Display controls cannot change evidence",
  );
  await page.locator("#texture-window").selectOption("hann");
  assert.equal(await page.locator("#texture-json").isDisabled(), true);
  await measure();
  const hann = await download("#texture-json", "hann.json");
  assert.equal(hann.parameters.window, "hann");
  assert.notEqual(hann.report_sha256, report.report_sha256);
  assert.ok(
    Math.abs(hann.psd.integral - hann.psd.expected_mean_square) < 1e-30,
  );
  await page.locator("#reset-selection").click();
  await page.locator("#texture-capture").click();
  assert.match(
    await page.locator("#texture-status").textContent(),
    /Capture refused/i,
  );
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  await measure();
  const independent = await download("#texture-json", "independent.json");
  assert.deepEqual(independent.input_recipe, report.input_recipe);
  await page.locator("#texture-capture").click();
  assert.equal(await page.locator("#texture-json").isDisabled(), true);
  await measure();
  const processed = await download("#texture-json", "processed.json");
  assert.equal(processed.input_recipe.operations.at(-1).name, "mean");
  await load("zero.gwy", fixture(Array(32).fill(0), null, 8, 4));
  await page.locator("#texture-capture").click();
  await measure();
  const zero = await download("#texture-json", "zero.json");
  assert.equal(zero.acf.normalized_overview, null);
  assert.equal(zero.arrays.acf_normalized, null);
  assert.equal(await page.locator("#texture-normalized").isDisabled(), true);
  const mask = Array(32).fill(0);
  mask[10] = 1;
  await load("masked.gwy", fixture(values, mask, 8, 4));
  await page.locator("#texture-capture").click();
  await page.locator("#texture-run").click();
  await page.waitForFunction(() =>
    document.querySelector("#texture-status.error"),
  );
  assert.match(
    await page.locator("#texture-status").textContent(),
    /internal mask|invalid pixels/,
  );
  assert.equal(await page.locator("#texture-json").isDisabled(), true);
  await load("waves-again.gwy", fixture(values, null, 8, 4));
  await page.locator("#texture-capture").click();
  await measure();
  for (const id of ["psd", "acf", "psd-cuts", "acf-cuts"]) {
    await page.locator("#texture-" + id).scrollIntoViewIfNeeded();
    await page
      .locator("#texture-" + id)
      .screenshot({ path: join(scratch, id + ".png") });
  }
  await page
    .locator("#panel-texture")
    .screenshot({ path: join(scratch, "texture-desktop.png") });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow at ${width}`,
    );
  }
  await page
    .locator("#panel-texture")
    .screenshot({ path: join(scratch, "texture-mobile.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      scratch,
      browser: await browser.version(),
      checks: [
        "known sinusoidal PSD/ACF",
        "report and raster SHA",
        "TAR parity",
        "display-only settings",
        "captured recipe independence",
        "processed recipe replay",
        "zero-energy handling",
        "mask rejection",
        "responsive layout",
        "main map invariance",
      ],
    }),
  );
} finally {
  await browser.close();
}
