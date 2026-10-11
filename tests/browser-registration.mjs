/** Optional synthetic browser translation-registration QA; no external measurement fixtures required. */
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
const scratch = await mkdtemp(join(tmpdir(), "afm-registration-browser-"));
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
async function register() {
  await page.locator("#registration-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#registration-json").disabled ||
      document.querySelector("#registration-status.error"),
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#registration-status.error").count(),
    0,
    await page.locator("#registration-status").textContent(),
  );
}
try {
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/");
  let seed = 12345;
  const fixed = Array.from({ length: 30 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 1e-8;
  });
  const moving = Array.from({ length: 30 }, (_, i) => {
    const x = i % 6,
      y = Math.floor(i / 6);
    return x < 5 && y > 0 ? fixed[(y - 1) * 6 + x + 1] : NaN;
  });
  await load("fixed.gwy", fixture(fixed, null, 6, 5));
  await page.locator("#tab-texture").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-registration").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#registration-capture-fixed").click();
  assert.equal(await page.locator("#registration-run").isDisabled(), true);
  await load("moving.gwy", fixture(moving, null, 6, 5));
  await page.locator("#registration-capture-moving").click();
  assert.equal(await page.locator("#registration-json").isDisabled(), true);
  const beforeMaps = await maps();
  await page.locator("#registration-mode").selectOption("automatic");
  await page.locator("#registration-radius-x").fill("2");
  await page.locator("#registration-radius-y").fill("2");
  await register();
  const automatic = await download("#registration-json", "automatic.json");
  assert.equal(automatic.kind, "translation_registration");
  assert.deepEqual(automatic.transform.pixel_shift, [1, -1]);
  assert.equal(automatic.transform.tx, 1e-6);
  assert.equal(automatic.transform.ty, -1e-6);
  assert.equal(automatic.metrics.valid_count, 20);
  assert.equal(automatic.metrics.rmse, 0);
  assert.equal(automatic.metrics.overlap_fraction, 20 / 30);
  assert.equal(automatic.search.tied_candidates.length, 1);
  assert.equal(automatic.search.boundary_peak, false);
  assert.equal(automatic.search.candidates.length, 25);
  assert.equal(
    await page.locator("#registration-candidates tbody tr").count(),
    10,
  );
  const unsigned = structuredClone(automatic);
  delete unsigned.report_sha256;
  assert.equal(digest(JSON.stringify(unsigned)), automatic.report_sha256);
  assert.deepEqual(await maps(), beforeMaps);
  const entries = tarFiles(
    await download("#registration-tar", "automatic.tar", false),
  );
  assert.deepEqual(JSON.parse(entries["report.json"]), automatic);
  for (const metadata of Object.values(automatic.arrays))
    assert.equal(digest(entries[metadata.file]), metadata.sha256);
  assert.equal(
    [...entries["valid.u8"]].reduce((a, b) => a + b, 0),
    20,
  );
  assert.ok(Number.isNaN(entries["aligned.f64"].readDoubleLE(0)));
  await page.locator("#registration-mode").selectOption("manual");
  assert.equal(await page.locator("#registration-json").isDisabled(), true);
  await page.locator("#registration-tx").fill("0.000001");
  await page.locator("#registration-ty").fill("-0.000001");
  await page.locator("#registration-interpolation").selectOption("nearest");
  await register();
  const manual = await download("#registration-json", "manual.json");
  assert.equal(manual.metrics.rmse, 0);
  assert.equal(manual.metrics.valid_count, 20);
  assert.equal(manual.search, null);
  assert.equal(manual.parameters.interpolation, "nearest");
  await page.locator("#registration-tx").fill("0.0000015");
  await page.locator("#registration-interpolation").selectOption("bilinear");
  await register();
  const fractional = await download("#registration-json", "fractional.json");
  assert.equal(fractional.parameters.interpolation, "bilinear");
  assert.ok(fractional.metrics.valid_count < 20);
  assert.ok(fractional.metrics.rmse > 0);
  await page.locator("#reset-selection").click();
  await page.locator("#registration-capture-moving").click();
  assert.match(
    await page.locator("#registration-status").textContent(),
    /Capture refused/i,
  );
  assert.equal(await page.locator("#registration-json").isDisabled(), false);
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  await register();
  const unchanged = await download("#registration-json", "independent.json");
  assert.deepEqual(unchanged.input_recipes, manual.input_recipes);
  await page.locator("#registration-capture-moving").click();
  await register();
  const processed = await download("#registration-json", "processed.json");
  assert.equal(processed.input_recipes.moving.operations.at(-1).name, "mean");
  await page.locator("#registration-mode").selectOption("automatic");
  await page.locator("#registration-radius-x").fill("65");
  await page.locator("#registration-run").click();
  assert.match(
    await page.locator("#registration-status").textContent(),
    /0 through 64/,
  );
  assert.equal(await page.locator("#registration-json").isDisabled(), true);
  await page.locator("#registration-radius-x").fill("2");
  await register();
  for (const id of ["aligned", "difference"]) {
    await page.locator("#registration-" + id).scrollIntoViewIfNeeded();
    await page
      .locator("#registration-" + id)
      .screenshot({ path: join(scratch, id + ".png") });
  }
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow at ${width}`,
    );
  }
  await page.locator("#registration-candidates").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, "registration-mobile.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      scratch,
      browser: await browser.version(),
      checks: [
        "known automatic translation",
        "manual/fractional interpolation",
        "both captured recipes",
        "missing overlap and hashes",
        "binary TAR parity",
        "display invalidation",
        "dirty capture refusal",
        "independent main edits",
        "seven-tab navigation",
        "mobile overflow",
      ],
    }),
  );
} finally {
  await browser.close();
}
