/** Generated data, real worker, browser line-polynomial regression. */
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
const scratch = await mkdtemp(join(tmpdir(), "afm-line-polynomial-"));
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1080 },
      acceptDownloads: true,
    }),
    errors = [];
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
  async function add(axis, degree) {
    await page.locator("#operation").selectOption("line_polynomial");
    await page.locator("#axis").selectOption(axis);
    await page.locator("#line-degree").selectOption(String(degree));
    await page.locator("#add").click();
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
  await page.locator("#import").setInputFiles({
    name: "line-polynomial.gwy",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await ready();
  const raw = await snapshot();
  assert.equal(raw.recipe.source.sha256, hash);
  await roi([1e-6, 1e-6, 7e-6, 7e-6]);
  await page.locator("#coordinate-polygon").fill(
    JSON.stringify([
      [1e-6, 1e-6],
      [2e-6, 1e-6],
      [2e-6, 2e-6],
      [1e-6, 2e-6],
    ]),
  );
  await page.locator("#coordinate-exclude").click();
  await page.locator("#refresh").click();
  await ready();
  const baseline = await snapshot();
  async function check(axis, degree) {
    await add(axis, degree);
    await ready();
    const actual = await snapshot(),
      operation = { name: "line_polynomial", params: { axis, degree } };
    assert.deepEqual(actual.recipe.operations, [operation]);
    assert.equal(await page.locator("#history li").count(), 1);
    assert.equal(
      await page.locator("#history button").textContent(),
      "line_polynomial " + JSON.stringify(operation.params),
    );
    const expected = await page.evaluate(
      async ({ raw, operation, selection }) => {
        const { applyOperation } = await import("./engine.js");
        const [height, width] = raw.channel.shape;
        const { channel } = applyOperation(
          {
            ...raw.channel,
            width,
            height,
            data: Float64Array.from(raw.data.flat()),
            mask: null,
          },
          operation,
          selection,
        );
        return Array.from(channel.data);
      },
      { raw, operation, selection: baseline.recipe.selection },
    );
    assert.deepEqual(actual.data.flat(), expected);
    assert.equal(actual.recipe.source.sha256, hash);
    return actual;
  }
  const rows = await check("rows", 2),
    legacy = await download("#download", "rows.json"),
    portable = await download("#download-portable", "rows-v2.json");
  assert.deepEqual(legacy.value, rows.recipe);
  assert.deepEqual(portable.value.recipe, rows.recipe);
  await page.locator("#undo").click();
  await ready();
  assert.deepEqual((await snapshot()).data, baseline.data);
  assert.deepEqual((await snapshot()).recipe.operations, []);
  for (const saved of [legacy, portable]) {
    await page.locator("#upload").setInputFiles(saved.path);
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        .textContent.includes("Recipe replay complete"),
    );
    await ready();
    const replayed = (await snapshot()).recipe;
    assert.deepEqual(
      { ...replayed, created_at: rows.recipe.created_at },
      rows.recipe,
    );
    assert.deepEqual((await snapshot()).data, rows.data);
  }
  const rejected = await page.evaluate(
    async ({ legacy, portable }) => {
      const { apiFetch } = await import("./api.js"),
        { canonicalRecipeJSON } = await import("./recipe-interchange.js"),
        { sha256 } = await import("./engine.js");
      const digest = (v) =>
        sha256(new TextEncoder().encode(canonicalRecipeJSON(v)));
      legacy.engine.sha256 = "0".repeat(64);
      portable.recipe.engine.sha256 = "0".repeat(64);
      portable.recipe_sha256 = await digest(portable.recipe);
      const { document_sha256, ...unsigned } = portable;
      portable.document_sha256 = await digest(unsigned);
      const answers = [];
      for (const recipe of [legacy, portable]) {
        const response = await apiFetch("/api/replay", {
          method: "POST",
          body: JSON.stringify({ recipe }),
        });
        answers.push({ ok: response.ok, body: await response.json() });
      }
      return answers;
    },
    { legacy: legacy.value, portable: portable.value },
  );
  for (const r of rejected) {
    assert.equal(r.ok, false);
    assert.match(r.body.detail, /engine/i);
  }
  assert.deepEqual((await snapshot()).data, rows.data);
  await page.locator("#undo").click();
  await ready();
  await check("columns", 1);
  await page.locator("#undo").click();
  await ready();
  await check("rows", 0);
  await page.locator("#undo").click();
  await ready();
  await roi([3e-6, 1e-6, 4e-6, 7e-6]);
  await add("rows", 2);
  await page.waitForFunction(() => document.querySelector("#status.error"));
  assert.match(
    await page.locator("#status").textContent(),
    /sample|degree|rank|points|underdetermined/i,
  );
  assert.equal(await page.locator("#download").isDisabled(), true);
  await page.locator("#undo").click();
  await ready();
  assert.equal((await snapshot()).recipe.source.sha256, hash);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await page.locator("#operation").isVisible()))
    await page.locator("#toggle-inspector").click();
  await page.locator("#operation").selectOption("line_polynomial");
  await page.locator("#line-degree").scrollIntoViewIfNeeded();
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
        "row degree2 exact engine",
        "ROI and exclusion",
        "undo legacy/v2 replay",
        "changed-engine rejection",
        "column degree1",
        "degree0",
        "underdetermined rejection/source integrity",
        "mobile",
      ],
    }),
  );
} finally {
  await browser.close();
}
