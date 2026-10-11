/** Optional synthetic browser sensitivity-analysis QA; no external measurement fixtures required. */
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
const scratch = await mkdtemp(join(tmpdir(), "afm-sensitivity-browser-"));
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
async function run() {
  await page.locator("#sensitivity-run").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#sensitivity-json").disabled ||
      document.querySelector("#sensitivity-status.error"),
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator("#sensitivity-status.error").count(),
    0,
    await page.locator("#sensitivity-status").textContent(),
  );
}
try {
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ contentType: "application/json", body: '{"files":[]}' }),
  );
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/");
  await load(
    "sensitivity.gwy",
    fixture([0, 1, 2, 3, 4, 5].map((x) => x * 1e-9)),
  );
  const before = await maps();
  await page.locator("#tab-registration").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.locator("#tab-sensitivity").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#sensitivity-capture").click();
  assert.deepEqual(
    JSON.parse(await page.locator("#sensitivity-variants").inputValue()),
    [],
  );
  await page.locator("#sensitivity-add-mean").click();
  await page.locator("#sensitivity-add-plane").click();
  assert.equal(await page.locator("#sensitivity-json").isDisabled(), true);
  const variants = JSON.parse(
    await page.locator("#sensitivity-variants").inputValue(),
  );
  assert.equal(variants[0].operations.at(-1).name, "mean");
  assert.equal(variants[1].operations.at(-1).name, "plane");
  variants.push({
    id: "roi",
    label: "Left columns",
    operations: [],
    selection: { roi: [0, 0, 2e-6, 2e-6] },
  });
  variants.push({
    id: "outside",
    label: "Empty ROI retained",
    operations: [],
    selection: { roi: [10, 10, 11, 11] },
  });
  await page
    .locator("#sensitivity-variants")
    .fill(JSON.stringify(variants, null, 2));
  await page
    .locator("#sensitivity-calibration-note")
    .fill("No certificate supplied");
  await page
    .locator("#sensitivity-model-note")
    .fill("Compare deterministic alternatives, not replicates");
  await run();
  const report = await download("#sensitivity-json", "sensitivity.json");
  assert.equal(report.kind, "analysis_sensitivity");
  assert.equal(report.status, "partial");
  assert.deepEqual(
    report.variants.map((v) => v.status),
    ["succeeded", "succeeded", "succeeded", "failed"],
  );
  assert.equal(report.variants[2].result.statistics.valid_count, 4);
  assert.ok(Math.abs(report.variants[0].result.statistics.mean) < 1e-22);
  assert.ok(Math.abs(report.variants[1].result.statistics.sq) < 1e-22);
  assert.equal(report.calibration_uncertainty.status, "not_evaluated");
  assert.equal(report.calibration_uncertainty.note, "No certificate supplied");
  assert.equal(await page.locator("#sensitivity-rows tbody tr").count(), 5);
  assert.equal(await page.locator("#sensitivity-rows tr.failed").count(), 1);
  const sa = report.summary.metrics.find((m) => m.key === "statistics.sa");
  assert.ok(Math.abs(sa.baseline - 1.5e-9) < 1e-22);
  assert.equal(sa.range.count, 4);
  assert.equal(sa.range.member_ids.includes("outside"), false);
  assert.equal(sa.values.filter((v) => v.id === "baseline").length, 1);
  assert.deepEqual(await maps(), before);
  const unsigned = structuredClone(report);
  delete unsigned.report_sha256;
  assert.equal(digest(JSON.stringify(unsigned)), report.report_sha256);
  const entries = tarFiles(
    await download("#sensitivity-tar", "sensitivity.tar", false),
  );
  assert.deepEqual(JSON.parse(entries["report.json"]), report);
  assert.deepEqual(
    JSON.parse(entries["baseline-recipe.json"]),
    report.request.baseline_recipe,
  );
  for (const v of report.variants)
    if (v.status === "succeeded")
      assert.deepEqual(
        JSON.parse(entries[`variant-${v.id}-recipe.json`]),
        v.result.recipe,
      );
  assert.equal(entries["variant-outside-recipe.json"], undefined);
  const tsv = await download("#sensitivity-tsv", "sensitivity.tsv", false);
  assert.ok(tsv.includes(Buffer.from(report.report_sha256)));
  assert.ok(tsv.includes(Buffer.from("outside")));
  await page.locator("#sensitivity-metric").selectOption("statistics.mean");
  assert.deepEqual(
    await download("#sensitivity-json", "display-only.json"),
    report,
  );
  await page.locator("#reset-selection").click();
  await page.locator("#sensitivity-capture").click();
  assert.match(
    await page.locator("#sensitivity-status").textContent(),
    /Capture refused/i,
  );
  assert.equal(await page.locator("#sensitivity-json").isDisabled(), false);
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  await run();
  const independent = await download("#sensitivity-json", "independent.json");
  assert.deepEqual(
    independent.request.baseline_recipe,
    report.request.baseline_recipe,
  );
  await page.locator("#sensitivity-add-current").click();
  assert.equal(await page.locator("#sensitivity-json").isDisabled(), true);
  const current = JSON.parse(
    await page.locator("#sensitivity-variants").inputValue(),
  ).at(-1);
  assert.equal(current.operations.at(-1).name, "mean");
  await load("other.gwy", fixture([0, 1, 2, 3, 4, 5].map((x) => x * 1e-9)));
  await page.locator("#sensitivity-add-current").click();
  assert.match(
    await page.locator("#sensitivity-status").textContent(),
    /must match/,
  );
  await load("zero.gwy", fixture(Array(6).fill(0)));
  await page.locator("#sensitivity-capture").click();
  await page.locator("#sensitivity-add-current").click();
  await run();
  const zero = await download("#sensitivity-json", "zero.json");
  const zeroSa = zero.summary.metrics.find((m) => m.key === "statistics.sa");
  assert.ok(
    zeroSa.values.every((v) => v.relative_delta === null && v.value === 0),
  );
  assert.equal(zeroSa.range.count, 2);
  await page.locator("#sensitivity-calibration-note").fill("Updated note");
  assert.equal(await page.locator("#sensitivity-json").isDisabled(), true);
  await run();
  await page.locator("#sensitivity-plot").scrollIntoViewIfNeeded();
  await page
    .locator("#sensitivity-plot")
    .screenshot({ path: join(scratch, "sensitivity-plot.png") });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow at ${width}`,
    );
  }
  await page.locator("#sensitivity-rows").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, "sensitivity-mobile.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      scratch,
      browser: await browser.version(),
      checks: [
        "explicit alternatives",
        "known leveling/ROI differences",
        "retained failure",
        "report and recipe export verification",
        "timestamp preservation",
        "zero-baseline deltas",
        "independent capture",
        "matching source gate",
        "eight-tab navigation",
        "mobile overflow",
      ],
    }),
  );
} finally {
  await browser.close();
}
