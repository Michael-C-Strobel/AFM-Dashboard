/** Real PNG downloads from generated data; no laboratory files or uploads. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine));
const scratch = await mkdtemp(join(tmpdir(), "afm-image-export-"));
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
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
    deviceScaleFactor: Number(process.env.AFM_IMAGE_DPR || 1),
  });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__imageAnalysisCalls = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (["analyze", "replay"].includes(message?.type))
        window.__imageAnalysisCalls++;
      return send.call(this, message, ...args);
    };
  });
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (route) => {
    errors.push("Unexpected repository measurement request");
    return route.abort();
  });
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4173/web/");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  assert.equal(await page.locator("#save-raw-png").isDisabled(), true);
  assert.equal(await page.locator("#save-result-png").isDisabled(), true);
  const bytes = createPreviewFixture();
  await page.locator("#import").setInputFiles([
    {
      name: "synthetic.gwy",
      mimeType: "application/octet-stream",
      buffer: bytes,
    },
    {
      name: "reference.gwy",
      mimeType: "application/octet-stream",
      buffer: bytes,
    },
  ]);
  const ready = () =>
    page.waitForFunction(() => !document.querySelector("#download").disabled);
  await ready();
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  const snapshot = () =>
    page.evaluate(async () => ({
      analysis: (await import("./app.js")).getAnalysisSnapshot(),
      calls: window.__imageAnalysisCalls,
    }));
  async function downloadMap(id, filename) {
    const before = await snapshot();
    const pending = page.waitForEvent("download");
    await page
      .locator(id === "raw" ? "#save-raw-png" : "#save-result-png")
      .click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), filename);
    const path = join(scratch, filename);
    await download.saveAs(path);
    const png = await readFile(path);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    const pixels = await page.evaluate(
      async ({ id, bytes }) => {
        const source = document.getElementById(id),
          ratio = source.width / source.clientWidth,
          url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          );
        try {
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
            image.src = url;
          });
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(image, 0, 0);
          const x = Math.floor(source.width * 0.57),
            y = Math.floor(source.height * 0.53);
          return {
            width: image.width,
            height: image.height,
            expectedWidth: Math.round((source.clientWidth + 32) * ratio),
            expectedHeight: Math.round((source.clientHeight + 136) * ratio),
            source: [...source.getContext("2d").getImageData(x, y, 1, 1).data],
            exported: [
              ...ctx.getImageData(
                Math.round(16 * ratio) + x,
                Math.round(64 * ratio) + y,
                1,
                1,
              ).data,
            ],
            legend: [
              ...ctx.getImageData(
                Math.round((16 + source.clientWidth * 0.3) * ratio),
                Math.round((64 + source.clientHeight + 20) * ratio),
                1,
                1,
              ).data,
            ],
          };
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      { id, bytes: [...png] },
    );
    assert.equal(pixels.width, pixels.expectedWidth);
    assert.equal(pixels.height, pixels.expectedHeight);
    assert.equal(pixels.source[3], 255);
    assert.deepEqual(
      pixels.exported,
      pixels.source,
      "retain displayed map pixels",
    );
    assert.equal(pixels.legend[3], 255);
    assert.deepEqual(
      await snapshot(),
      before,
      "image export must not analyze or change the scientific snapshot",
    );
    return pixels;
  }
  await downloadMap("raw", "afm-original.png");
  const viridis = await downloadMap("result", "afm-processed.png");
  await page.locator("#palette").selectOption("inferno");
  const inferno = await downloadMap("result", "afm-processed.png");
  assert.notDeepEqual(viridis.legend, inferno.legend);
  await page.locator("#view").selectOption("reference");
  assert.equal(await page.locator("#save-result-png").isDisabled(), true);
  assert.equal(await page.locator("#save-raw-png").isDisabled(), false);
  await page.locator("#view").selectOption("processed");
  await page.locator("#reference-file").selectOption("reference.gwy");
  await page.waitForFunction(
    () => !document.querySelector("#compare").disabled,
  );
  await page.locator("#compare").check();
  await ready();
  await page.locator("#view").selectOption("reference");
  await downloadMap("result", "afm-reference.png");
  await page.locator("#view").selectOption("difference");
  await downloadMap("result", "afm-difference.png");
  await page.locator("#view").selectOption("processed");
  await page.locator("#tool").selectOption("roi");
  const map = await page.locator("#result").boundingBox();
  await page.mouse.move(map.x + map.width * 0.25, map.y + map.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width * 0.75, map.y + map.height * 0.75);
  await page.mouse.up();
  assert.equal(await page.locator("#save-raw-png").isDisabled(), true);
  assert.equal(await page.locator("#save-result-png").isDisabled(), true);
  await page.locator("#refresh").click();
  await ready();
  await downloadMap("result", "afm-processed.png");
  await page.screenshot({ path: join(scratch, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#save-result-png").scrollIntoViewIfNeeded();
  await downloadMap("result", "afm-processed.png");
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: join(scratch, "mobile.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine,
      browser: browser.version(),
      status: "passed",
      scratch,
    }),
  );
} finally {
  await browser.close();
}
