/** Real browser-worker three-point editor checks using generated data only. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine));
const base = process.env.AFM_BASE_URL || "http://127.0.0.1:4191/web/";
const scratch = await mkdtemp(join(tmpdir(), "afm-three-point-browser-"));
const browser = await playwright[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (r) => {
    errors.push("Unexpected repository measurement fetch");
    return r.abort();
  });
  const snapshot = () =>
    page.evaluate(async () => {
      const { getAnalysisSnapshot } = await import("./app.js");
      return getAnalysisSnapshot();
    });
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
  async function coordinates(points) {
    for (let i = 0; i < 3; i++) {
      await page.locator("#level-x-" + i).fill(String(points[i][0]));
      await page.locator("#level-y-" + i).fill(String(points[i][1]));
    }
    await page.locator("#level-update").click();
  }
  async function storedPoints() {
    return Promise.all(
      [0, 1, 2].map(async (i) => [
        Number(await page.locator("#level-x-" + i).inputValue()),
        Number(await page.locator("#level-y-" + i).inputValue()),
      ]),
    );
  }
  async function preview() {
    await page.locator("#level-preview").click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#level-apply").disabled ||
        document.querySelector("#level-status").classList.contains("error"),
    );
    assert.equal(
      await page.locator("#level-apply").isDisabled(),
      false,
      await page.locator("#level-status").textContent(),
    );
  }
  async function rejected(points, pattern) {
    await coordinates(points);
    if (
      !(await page
        .locator("#level-status")
        .evaluate((e) => e.classList.contains("error")))
    )
      await page.locator("#level-preview").click();
    await page.waitForFunction(() =>
      document.querySelector("#level-status").classList.contains("error"),
    );
    assert.equal(await page.locator("#level-apply").isDisabled(), true);
    assert.match(await page.locator("#level-status").textContent(), pattern);
  }
  function centers(c) {
    const [h, w] = c.shape,
      dx = c.xreal / w,
      dy = c.yreal / h;
    return [
      [c.xoff + 1.5 * dx, c.yoff + 1.5 * dy],
      [c.xoff + (w - 1.5) * dx, c.yoff + 1.5 * dy],
      [c.xoff + 1.5 * dx, c.yoff + (h - 1.5) * dy],
    ];
  }
  async function canvasPoint(p, g, zoom = 1, pan = [0, 0]) {
    await page.locator("#result").scrollIntoViewIfNeeded();
    return page.locator("#result").evaluate(
      (canvas, { p, g, zoom, pan }) => {
        const bounds = canvas.getBoundingClientRect(),
          w = canvas.clientWidth,
          h = canvas.clientHeight;
        let rw = w - 36,
          rh = rw / (g.xreal / g.yreal);
        if (rh > h - 36) {
          rh = h - 36;
          rw = (rh * g.xreal) / g.yreal;
        }
        rw *= zoom;
        rh *= zoom;
        return {
          tolerance: [(1.1 * g.xreal) / rw, (1.1 * g.yreal) / rh],
          x:
            bounds.left +
            (w - rw) / 2 +
            pan[0] +
            ((p[0] - g.xoff) / g.xreal) * rw,
          y:
            bounds.top +
            (h - rh) / 2 +
            pan[1] +
            ((p[1] - g.yoff) / g.yreal) * rh,
        };
      },
      { p, g, zoom, pan },
    );
  }
  async function pick(points, g, zoom = 1, pan = [0, 0]) {
    const tolerances = [];
    for (let i = 0; i < 3; i++) {
      await page.locator("#level-point").selectOption(String(i));
      const p = await canvasPoint(points[i], g, zoom, pan);
      tolerances.push(p.tolerance);
      await page.mouse.click(p.x, p.y);
    }
    const stored = await storedPoints();
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++)
        assert.ok(
          Math.abs(stored[i][j] - points[i][j]) < tolerances[i][j],
          `physical canvas pick accuracy ${JSON.stringify({ stored, points, i, j })}`,
        );
    return stored;
  }
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent.includes("Import a local"),
  );
  const file = join(scratch, "three-point-synthetic.gwy");
  await writeFile(file, createPreviewFixture());
  await page.locator("#import").setInputFiles(file);
  await ready();
  const original = await snapshot();
  assert.equal(
    original.recipe.source.sha256,
    "070d5511c2b04a14a98dc9f9a5f720bc08b0c2e5b8f25a7cd403453698cd1f19",
  );
  await page.locator("#three-point-editor > summary").click();
  await page.locator("#three-point-start").click();
  assert.equal(await page.locator("#tool").inputValue(), "level-points");
  const points = await pick(centers(original.channel), original.channel);
  await page.locator("#level-radius").fill("1");
  await page.locator("#level-update").click();
  await preview();
  assert.equal(
    await page.locator("#result-badge").textContent(),
    "DRAFT PREVIEW",
  );
  assert.equal(await page.locator("#download").isDisabled(), true);
  assert.equal(await page.locator("#history li").count(), 0);
  assert.equal(await snapshot(), null);
  await page.locator("#level-cancel").click();
  await ready();
  assert.deepEqual(
    await snapshot(),
    original,
    "cancel restores exact committed analysis",
  );
  await page.locator("#three-point-start").click();
  await coordinates(points);
  await preview();
  await page.locator("#level-x-0").fill(String(points[0][0] + 1e-8));
  assert.equal(
    await page.locator("#level-apply").isDisabled(),
    true,
    "editing invalidates preview approval",
  );
  await coordinates(points);
  await preview();
  await page.locator("#level-apply").click();
  await ready();
  const applied = await snapshot();
  assert.deepEqual(applied.recipe.operations, [
    { name: "three_point", params: { points, radius: 1 } },
  ]);
  assert.equal(await page.locator("#history li").count(), 1);
  const direct = await page.evaluate(
    async ({ baseline, points }) => {
      const { runPipeline } = await import("./engine.js");
      const [height, width] = baseline.channel.shape;
      const result = runPipeline(
        {
          ...baseline.channel,
          width,
          height,
          data: Float64Array.from(baseline.data.flat()),
          mask: null,
        },
        [{ name: "three_point", params: { points, radius: 1 } }],
        baseline.recipe.selection,
      );
      return {
        data: Array.from(result.channel.data),
        statistics: result.statistics,
      };
    },
    { baseline: original, points },
  );
  assert.deepEqual(applied.data.flat(), direct.data);
  assert.deepEqual(applied.statistics, direct.statistics);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#download").click();
  const recipePath = join(scratch, "three-point-recipe.json");
  await (await downloadEvent).saveAs(recipePath);
  assert.deepEqual(
    JSON.parse(await readFile(recipePath, "utf8")),
    applied.recipe,
  );
  await page.locator("#undo").click();
  await ready();
  assert.deepEqual((await snapshot()).recipe.operations, []);
  assert.deepEqual((await snapshot()).data, original.data);
  await page.locator("#upload").setInputFiles(recipePath);
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Recipe replay complete"),
  );
  await ready();
  assert.deepEqual((await snapshot()).data, applied.data);
  assert.deepEqual(
    await storedPoints(),
    points,
    "replay rehydrates marker coordinate fields",
  );
  await page.locator("#three-point-start").click();
  await rejected(
    [
      [1e-6, 1e-6],
      [2e-6, 2e-6],
      [3e-6, 3e-6],
    ],
    /singular|collinear|degenerate/i,
  );
  await rejected(
    [
      [8e-6, 1e-6],
      [1e-6, 2e-6],
      [3e-6, 4e-6],
    ],
    /invalid|outside|bound/i,
  );
  await page.locator("#level-reset").click();
  assert.equal(await page.locator("#level-apply").isDisabled(), true);
  await page.locator("#level-cancel").click();
  await ready();
  // A smaller ROI makes otherwise in-image point neighborhoods unusable.
  await page.locator("#clear").click();
  await ready();
  await page.locator("#tab-measurements").click();
  await page.locator(".coordinate-panel > summary").click();
  async function roi(bounds) {
    for (const [id, value] of ["x0", "y0", "x1", "y1"].map((k, i) => [
      k,
      bounds[i],
    ]))
      await page.locator("#coord-" + id).fill(String(value));
    await page.locator("#coordinate-roi").click();
    await page.locator("#refresh").click();
    await ready();
  }
  await roi([0, 0, 1e-6, 1e-6]);
  await page.locator("#three-point-start").click();
  await rejected(points, /no valid|selection/i);
  await page.locator("#level-cancel").click();
  await ready();
  // Crop creates non-square geometry and nonzero offsets; test transformed picking there.
  await roi([2e-6, 1e-6, 6e-6, 3e-6]);
  await page.locator("#operation").selectOption("crop");
  await page.locator("#add").click();
  await ready();
  const cropped = await snapshot();
  assert.equal(cropped.channel.xoff, 2e-6);
  assert.equal(cropped.channel.yoff, 1e-6);
  assert.notEqual(cropped.channel.xreal, cropped.channel.yreal);
  await page.locator("#reset-view").click();
  await page.locator("#tool").selectOption("navigate");
  let center = await canvasPoint(
    [
      cropped.channel.xoff + cropped.channel.xreal / 2,
      cropped.channel.yoff + cropped.channel.yreal / 2,
    ],
    cropped.channel,
  );
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(100);
  const zoom = Math.exp(0.2),
    pan = [12, 8];
  center = await canvasPoint(
    [
      cropped.channel.xoff + cropped.channel.xreal / 2,
      cropped.channel.yoff + cropped.channel.yreal / 2,
    ],
    cropped.channel,
    zoom,
  );
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + pan[0], center.y + pan[1], { steps: 3 });
  await page.mouse.up();
  await page.locator("#three-point-start").click();
  await pick(centers(cropped.channel), cropped.channel, zoom, pan);
  await preview();
  await page.locator("#level-cancel").click();
  await ready();
  assert.deepEqual(
    await snapshot(),
    cropped,
    "cropped committed result unchanged by preview/cancel",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      scratch,
      browserEngine,
      checks: [
        "pick/keyboard",
        "preview/cancel/apply",
        "direct-engine equality",
        "replay/undo",
        "invalid points/ROI",
        "crop/offset/non-square/pan/zoom",
        "mobile",
      ],
    }),
  );
} finally {
  await browser.close();
}
