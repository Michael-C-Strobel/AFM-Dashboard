/** Capture the real dashboard using generated mathematical data only. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "firefox";
const uint = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const double = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b;
};
const string = (s) => Buffer.from(s + "\0");
const item = (name, type, data) =>
  Buffer.concat([string(name), Buffer.from(type), data]);
const object = (name, fields) => {
  const bytes = Buffer.concat(fields);
  return Buffer.concat([string(name), uint(bytes.length), bytes]);
};
const width = 240,
  height = 160;
const values = Buffer.alloc(width * height * 8);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const u = x / width,
      v = y / height;
    const terrace =
      12 * (Math.tanh((u - 0.38 - 0.1 * Math.sin(v * 6)) * 30) + 1);
    const island =
      22 * Math.exp(-((u - 0.72) ** 2 / 0.006 + (v - 0.45) ** 2 / 0.02));
    const texture =
      1.2 * Math.sin(x * 0.42 + Math.sin(y * 0.2)) * Math.cos(y * 0.32);
    values.writeDoubleLE(
      (8 * u + 5 * v + terrace + island + texture) * 1e-9,
      8 * (y * width + x),
    );
  }
const unit = () => object("GwySIUnit", [item("unitstr", "s", string("m"))]);
const field = object("GwyDataField", [
  item("xres", "i", uint(width)),
  item("yres", "i", uint(height)),
  item("xreal", "d", double(12e-6)),
  item("yreal", "d", double(8e-6)),
  item("si_unit_xy", "o", unit()),
  item("si_unit_z", "o", unit()),
  item("data", "D", Buffer.concat([uint(width * height), values])),
]);
const bytes = Buffer.concat([
  Buffer.from("GWYP"),
  object("GwyContainer", [
    item("/0/data", "o", field),
    item("/0/data/title", "s", string("Generated demo height")),
  ]),
]);
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\//, (r) => {
    if (new URL(r.request().url()).pathname === "/data/manifest.json")
      return r.fallback();
    errors.push("Unexpected measurement request");
    return r.abort();
  });
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4173/web/");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  await page
    .locator("#import")
    .setInputFiles({
      name: "Synthetic surface demo.gwy",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
  const ready = () =>
    page.waitForFunction(() => !document.querySelector("#download").disabled);
  await ready();
  await page.locator("#operation").selectOption("mean");
  await page.locator("#add").click();
  await ready();
  await page.locator("#palette").selectOption("inferno");
  // Add a real calculated profile through the normal coordinate controls.
  await page.locator("#tab-measurements").click();
  await page.locator(".coordinate-panel > summary").click();
  for (const [id, value] of Object.entries({
    "coord-x0": "0.5e-6",
    "coord-y0": "4e-6",
    "coord-x1": "11.5e-6",
    "coord-y1": "4e-6",
  }))
    await page.locator("#" + id).fill(value);
  await page.locator("#coordinate-profile").click();
  await page.locator("#refresh").click();
  await ready();
  await page.locator(".coordinate-panel > summary").click();
  await page.locator("#tool").selectOption("navigate");
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  assert.equal(await page.locator("#save-result-png").isDisabled(), false);
  assert.deepEqual(errors, []);
  const output = fileURLToPath(
    new URL("../docs/images/dashboard.png", import.meta.url),
  );
  await mkdir(fileURLToPath(new URL("../docs/images/", import.meta.url)), {
    recursive: true,
  });
  const dock = await page.locator(".inspection-dock").boundingBox();
  await page.screenshot({
    path: output,
    clip: { x: 0, y: 0, width: 1440, height: Math.floor(dock.y) - 8 },
  });
  console.log(
    JSON.stringify({
      image: output,
      generated: true,
      source: "deterministic mathematical surface; no instrument measurements",
      processing: "mean subtraction",
      browser: browser.version(),
    }),
  );
} finally {
  await browser.close();
}
