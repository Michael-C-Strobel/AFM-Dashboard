/** Reproduce plateau measurement after independently captured leveling operations. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright"),
  browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine));
const browser = await pw[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
const scratch = await mkdtemp(join(tmpdir(), "afm-plateau-leveling-"));
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
      acceptDownloads: true,
    }),
    errors = [];
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (
        ["analyze", "replay"].includes(message?.type) &&
        message.responseEncoding === "json"
      ) {
        const worker = this,
          receive = (e) => {
            if (e.data.id !== message.id) return;
            worker.removeEventListener("message", receive);
            if (!e.data.error)
              window.__surfaceResult = JSON.parse(
                new TextDecoder().decode(e.data.result),
              );
          };
        worker.addEventListener("message", receive);
      }
      return post.call(this, message, ...args);
    };
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(gwy|spm|ibw|jpk)(\?|$)/, (r) => {
    errors.push("Unexpected measurement request");
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
  async function download(id, name) {
    const event = page.waitForEvent("download");
    await page.locator(id).click();
    const path = join(scratch, name);
    await (await event).saveAs(path);
    return { path, value: JSON.parse(await readFile(path, "utf8")) };
  }
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4191/web/");
  const bytes = createPreviewFixture(),
    hash = createHash("sha256").update(bytes).digest("hex");
  await page
    .locator("#import")
    .setInputFiles({
      name: "plateau-after-leveling.gwy",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
  await ready();
  const raw = await snapshot();
  await page.locator("#three-point-editor > summary").click();
  await page.locator("#three-point-start").click();
  const points = [
    [0.75e-6, 0.75e-6],
    [2.75e-6, 0.75e-6],
    [0.75e-6, 6.75e-6],
  ];
  for (let i = 0; i < 3; i++)
    for (const [j, axis] of ["x", "y"].entries())
      await page.locator(`#level-${axis}-${i}`).fill(String(points[i][j]));
  await page.locator("#level-radius").fill("1");
  await page.locator("#level-update").click();
  await page.locator("#level-preview").click();
  await page.waitForFunction(
    () => !document.querySelector("#level-apply").disabled,
  );
  await page.locator("#level-apply").click();
  await ready();
  await page.locator("#operation").selectOption("zero_min");
  await page.locator("#add").click();
  await ready();
  const leveled = await snapshot();
  const selection = { roi: null, exclude_polygons: [] };
  assert.deepEqual(leveled.recipe.operations, [
    { name: "three_point", params: { points, radius: 1 }, selection },
    { name: "zero_min", params: {}, selection },
  ]);
  const a = [1e-6, 2e-6, 2e-6, 3e-6],
    b = [5e-6, 2e-6, 6e-6, 3e-6];
  await roi(a);
  assert.deepEqual((await snapshot()).data, leveled.data);
  await page.locator("#plateau-a").click();
  await roi(b);
  assert.deepEqual((await snapshot()).data, leveled.data);
  await page.locator("#plateau-b").click();
  await page.locator("#refresh").click();
  await ready();
  const measured = await snapshot(),
    result = await page.evaluate(() => window.__surfaceResult);
  assert.deepEqual(measured.recipe.operations, leveled.recipe.operations);
  assert.deepEqual(measured.recipe.plateaus, [a, b]);
  assert.deepEqual(measured.recipe.selection.roi, b);
  assert.equal(measured.recipe.output.sha256, leveled.recipe.output.sha256);
  assert.deepEqual(measured.data, leveled.data);
  assert.equal(measured.recipe.source.sha256, hash);
  const expected = await page.evaluate(
    async ({ raw, operations, plateaus, selection }) => {
      const { runPipeline, stepHeight } = await import("./engine.js");
      const [height, width] = raw.channel.shape;
      const c = runPipeline(
        {
          ...raw.channel,
          width,
          height,
          data: Float64Array.from(raw.data.flat()),
          mask: null,
        },
        operations,
        selection,
      ).channel;
      return {
        data: Array.from(c.data),
        step: stepHeight(c, plateaus, selection),
      };
    },
    {
      raw,
      operations: leveled.recipe.operations,
      plateaus: [a, b],
      selection: measured.recipe.selection,
    },
  );
  assert.deepEqual(measured.data.flat(), expected.data);
  assert.deepEqual(result.step, expected.step);
  assert.ok(Math.abs(result.step.height - 5e-9) < 1e-22);
  assert.equal(result.step.plateau_a.count, 4);
  assert.equal(result.step.plateau_b.count, 4);
  assert.match(await page.locator("#step").textContent(), /Mean B − mean A/);
  const legacy = await download("#download", "plateau.json"),
    portable = await download("#download-portable", "plateau-v2.json");
  assert.deepEqual(legacy.value, measured.recipe);
  assert.deepEqual(portable.value.recipe, measured.recipe);
  for (const saved of [legacy, portable]) {
    await page.locator("#upload").setInputFiles(saved.path);
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        .textContent.includes("Recipe replay complete"),
    );
    await ready();
    const replayed = await snapshot();
    assert.deepEqual(
      { ...replayed.recipe, created_at: measured.recipe.created_at },
      measured.recipe,
    );
    assert.deepEqual(replayed.data, leveled.data);
    assert.deepEqual(
      await page.evaluate(() => window.__surfaceResult.step),
      expected.step,
    );
  }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browserEngine,
      scratch,
      height: result.step.height,
      source_sha256: hash,
      checks: [
        "fixed operation selections",
        "disjoint plateau ROIs preserve pixels",
        "exact step/direct engine",
        "legacy/v2 replay",
        "raw unchanged",
      ],
    }),
  );
} finally {
  await browser.close();
}
