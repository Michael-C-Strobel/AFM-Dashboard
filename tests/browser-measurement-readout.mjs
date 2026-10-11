/** Optional real-browser chart cursor regression; generated data only. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine));
const scratch = await mkdtemp(join(tmpdir(), "afm-measurement-readout-"));
const browser = await playwright[engine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (engine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1320, height: 940 },
  });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.analysisMessages = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.type === "analyze" || message?.type === "replay")
        window.analysisMessages++;
      return post.call(this, message, ...rest);
    };
  });
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (r) => {
    errors.push("Unexpected measurement fetch");
    return r.abort();
  });
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4186/web/");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  const fixture = join(scratch, "synthetic-readout.gwy");
  await writeFile(fixture, createPreviewFixture());
  await page.locator("#import").setInputFiles(fixture);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("#tab-measurements").click();
  await page.locator("#expand-inspection").click();
  await page.locator(".coordinate-panel > summary").click();
  for (const [id, value] of Object.entries({
    "coord-x0": "0.25e-6",
    "coord-y0": "0.25e-6",
    "coord-x1": "7.75e-6",
    "coord-y1": "0.25e-6",
  }))
    await page.locator("#" + id).fill(value);
  await page.locator("#coordinate-profile").click();
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#download").disabled &&
      !!document.querySelector("#profile-readout"),
  );
  const snapshot = () =>
    page.evaluate(async () => {
      const { getAnalysisSnapshot } = await import("./app.js");
      return {
        analysis: getAnalysisSnapshot(),
        messages: window.analysisMessages,
      };
    });
  const before = await snapshot();
  // Map SVG coordinates through its screen CTM, including mobile letterboxing.
  async function moveTo(chart, x, y = 90) {
    const svg = page.locator("#" + chart + " svg");
    await svg.scrollIntoViewIfNeeded();
    const point = await svg.evaluate(
      (node, { x, y }) => {
        const p = new DOMPoint(x, y).matrixTransform(node.getScreenCTM());
        return { x: p.x, y: p.y };
      },
      { x, y },
    );
    await page.mouse.move(point.x, point.y);
  }
  const readout = (chart) =>
    page.locator("#" + chart + "-readout").textContent();
  async function keyboard(chart, key) {
    await page.locator("#" + chart + " svg").focus();
    await page.keyboard.press(key);
    return readout(chart);
  }
  const histogramCursor = page.locator("#histogram .measurement-cursor");
  const cursorVisibility = () =>
    histogramCursor.evaluate((n) => getComputedStyle(n).visibility);
  assert.equal(await cursorVisibility(), "hidden");
  // Assertions below use the presented values, not screenshots or altered DOM.
  await moveTo("histogram", 55 + 420 / 64);
  const firstBin = await readout("histogram");
  assert.equal(await cursorVisibility(), "visible");
  await page.mouse.down();
  await moveTo("histogram", 55 + (420 * 31.5) / 32);
  await page.mouse.up();
  const lastBin = await readout("histogram");
  assert.notEqual(firstBin, lastBin);
  const h = before.analysis.statistics.histogram;
  assert.match(firstBin, new RegExp("Bin 1/32:.*" + h.counts[0] + " pixels"));
  assert.match(
    lastBin,
    new RegExp(
      "Bin 32/32:.*" + h.counts.at(-1) + " pixels.*final upper edge included",
    ),
  );
  assert.equal(
    await page.locator("#histogram-readout").getAttribute("title"),
    `[${h.edges.at(-2)} m, ${h.edges.at(-1)} m]; count=${h.counts.at(-1)}`,
  );
  await page.mouse.move(0, 0);
  assert.equal(
    await cursorVisibility(),
    "hidden",
    "Pointer focus must not retain the bin highlight",
  );
  assert.equal(await readout("histogram"), lastBin);
  assert.equal(await keyboard("histogram", "Home"), firstBin);
  assert.equal(await cursorVisibility(), "visible");
  assert.equal(await keyboard("histogram", "End"), lastBin);
  assert.notEqual(await keyboard("histogram", "ArrowLeft"), lastBin);
  assert.equal(await keyboard("histogram", "ArrowRight"), lastBin);
  await page.locator("#profile svg").focus();
  assert.equal(await cursorVisibility(), "hidden");
  await moveTo("profile", 65);
  const firstSample = await readout("profile");
  await page.mouse.down();
  await moveTo("profile", 480);
  await page.mouse.up();
  const lastSample = await readout("profile");
  assert.notEqual(firstSample, lastSample);
  // Preserve the engine's floating-point ceil behavior; ideal arithmetic is 16.
  const sampleCount = Math.ceil((7.75e-6 - 0.25e-6) / (8e-6 / 16)) + 1;
  assert.match(
    firstSample,
    new RegExp(
      `sample 1/${sampleCount}.*Distance 0.*Height 0.*Source X 250 nm.*Y 250 nm`,
    ),
  );
  assert.match(
    lastSample,
    new RegExp(
      `sample ${sampleCount}/${sampleCount}.*Distance 7.5 µm.*Height 20 nm.*Source X 7.75 µm.*Y 250 nm`,
    ),
  );
  const exact = await page.locator("#profile-readout").getAttribute("title");
  const numbers = [
    ...exact.matchAll(/(?:distance|height|x|y)=([\deE+.\-]+) m/g),
  ].map((m) => Number(m[1]));
  assert.equal(numbers.length, 4);
  [7.5e-6, 20e-9, 7.75e-6, 0.25e-6].forEach((expected, i) =>
    assert.ok(Math.abs(numbers[i] - expected) < 1e-18),
  );
  await moveTo("profile", 65 + (415 * 8.1) / (sampleCount - 1));
  assert.equal(
    await page.locator("#profile-readout").getAttribute("data-index"),
    "8",
  );
  assert.match(
    await readout("profile"),
    new RegExp(`sample 9/${sampleCount}.*Height 10 nm`),
  );
  assert.equal(await keyboard("profile", "Home"), firstSample);
  assert.equal(await keyboard("profile", "End"), lastSample);
  assert.notEqual(await keyboard("profile", "ArrowLeft"), lastSample);
  assert.equal(await keyboard("profile", "ArrowRight"), lastSample);
  await page.setViewportSize({ width: 390, height: 844 });
  await moveTo("profile", 65);
  assert.equal(await readout("profile"), firstSample);
  await moveTo("profile", 480);
  assert.equal(await readout("profile"), lastSample);
  await moveTo("histogram", 55 + 420 / 64);
  assert.equal(await readout("histogram"), firstBin);
  assert.equal(await keyboard("histogram", "End"), lastBin);
  assert.deepEqual(
    await snapshot(),
    before,
    "Cursor interaction must not recalculate or change recipe, data, or statistics",
  );
  // A single-row ROI has empty histogram bins; these must remain inspectable.
  await page.setViewportSize({ width: 1320, height: 940 });
  for (const [id, value] of Object.entries({
    "coord-x0": "0",
    "coord-y0": "0",
    "coord-x1": "8e-6",
    "coord-y1": "0.5e-6",
  }))
    await page.locator("#" + id).fill(value);
  await page.locator("#coordinate-roi").click();
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  const selected = await snapshot(),
    zero = selected.analysis.statistics.histogram.counts.indexOf(0);
  assert.ok(zero >= 0, "Synthetic single row must contain an empty bin");
  await moveTo("histogram", 55 + (420 * (zero + 0.5)) / 32);
  assert.equal(
    await page.locator("#histogram-readout").getAttribute("data-index"),
    String(zero),
  );
  assert.match(await readout("histogram"), /· 0 pixels/);
  assert.deepEqual(await snapshot(), selected);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      firstBin,
      lastBin,
      firstSample,
      lastSample,
      analysisMessages: before.messages,
    }),
  );
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
