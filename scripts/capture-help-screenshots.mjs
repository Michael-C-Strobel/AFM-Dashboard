/** Capture the actual basic UI with generated data only; no image editing.
 * Run against an existing server with AFM_BASE_URL and PLAYWRIGHT_MODULE.
 * Optional --out directory replaces the default repository web/ destination.
 * Fixture provenance: createPreviewFixture(); SHA-256 is printed on completion.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewFixture } from "./preview-fixture.mjs";
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--out"),
  "Usage: node scripts/capture-help-screenshots.mjs [--out directory]",
);
const out = args.length
  ? resolve(args[1])
  : fileURLToPath(new URL("../web/", import.meta.url));
const base = process.env.AFM_BASE_URL || "http://127.0.0.1:4186/web/";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(
  ["chromium", "firefox", "webkit"].includes(engine),
  "Unsupported browser",
);
const viewport = { width: 1320, height: 940 };
const scratch = await mkdtemp(join(tmpdir(), "afm-help-capture-"));
const fixture = createPreviewFixture();
let browser;
try {
  const path = join(scratch, "synthetic-training-surface.gwy");
  await writeFile(path, fixture);
  await mkdir(out, { recursive: true });
  browser = await playwright[engine].launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE ||
      (engine === "chromium"
        ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        : undefined),
  });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\//, (r) => {
    if (new URL(r.request().url()).pathname === "/data/manifest.json")
      return r.fallback();
    errors.push("Unexpected measurement request: " + r.request().url());
    return r.abort();
  });
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  await page.locator("#import").setInputFiles(path);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(out, "help-import.png") });
  await page.locator("#tab-measurements").click();
  await page.locator("#expand-inspection").click();
  await page.locator("#panel-measurements .coordinate-panel > summary").click();
  assert.equal(
    await page
      .locator("#inspection-dialog")
      .evaluate((n) => n.matches(":modal")),
    true,
  );
  for (const id of [
    "coordinate-roi",
    "coordinate-profile",
    "plateau-a",
    "plateau-b",
  ]) {
    const box = await page.locator("#" + id).boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= viewport.height,
      id + " must be visible",
    );
  }
  await page.screenshot({ path: join(out, "help-measurements.png") });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: engine,
      viewport,
      synthetic_fixture: {
        file: "synthetic-training-surface.gwy",
        sha256: createHash("sha256").update(fixture).digest("hex"),
      },
      screenshots: [
        {
          file: join(out, "help-import.png"),
          view: "Imported synthetic source, channel selector and original/processed overview; no processing operations added.",
        },
        {
          file: join(out, "help-measurements.png"),
          view: "Measurements tab, expanded inspection, exact selection coordinates disclosure open; ROI/profile/plateau entry controls, no selections or step-height results invented.",
        },
      ],
    }),
  );
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
