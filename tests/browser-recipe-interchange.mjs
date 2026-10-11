/** Optional synthetic portable-recipe browser regression; external server lifecycle. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
function fixture(offset = 0, unit = "m") {
  const string = (text) => Buffer.from(text + "\0");
  const uint = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const item = (name, type, payload) =>
    Buffer.concat([string(name), Buffer.from(type), payload]);
  const object = (name, fields) => {
    const bytes = Buffer.concat(fields);
    return Buffer.concat([string(name), uint(bytes.length), bytes]);
  };
  const double = (n) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return b;
  };
  const field = object("GwyDataField", [
    item("xres", "i", uint(3)),
    item("yres", "i", uint(2)),
    item("xreal", "d", double(3e-6)),
    item("yreal", "d", double(2e-6)),
    item(
      "si_unit_xy",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string("m"))]),
    ),
    item(
      "si_unit_z",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string(unit))]),
    ),
    item(
      "data",
      "D",
      Buffer.concat([
        uint(6),
        ...[0, 1, 2, 3, 4, 5].map((n) => double(n * 1e-9 + offset)),
      ]),
    ),
  ]);
  return Buffer.concat([
    Buffer.from("GWYP"),
    object("GwyContainer", [
      item("/0/data", "o", field),
      item("/0/data/title", "s", string("Height_Trace")),
    ]),
  ]);
}

const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? "[" + value.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
          .join(",") +
        "}";
const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function signed(recipe) {
  const doc = {
    kind: "afm_recipe_document",
    schema_version: 2,
    canonicalization: "afm-json-v1",
    recipe,
    recipe_sha256: digest(recipe),
  };
  return { ...doc, document_sha256: digest(doc) };
}
function reordered(value) {
  return value === null || typeof value !== "object"
    ? value
    : Array.isArray(value)
      ? value.map(reordered)
      : Object.fromEntries(
          Object.keys(value)
            .reverse()
            .map((k) => [k, reordered(value[k])]),
        );
}
const scratch = await mkdtemp(join(tmpdir(), "afm-recipe-browser-"));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ files: [] }),
    }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (route) => {
    errors.push("Unexpected source download");
    return route.abort();
  });
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  const path = join(scratch, "synthetic.gwy");
  await writeFile(path, fixture());
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#import-trigger").focus();
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(path);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  async function download(id, name) {
    const event = page.waitForEvent("download");
    await page.locator(id).click();
    const file = await event;
    const target = join(scratch, name);
    await file.saveAs(target);
    return JSON.parse(await readFile(target, "utf8"));
  }
  async function load(value, name, expectedError = null) {
    const target = join(scratch, name);
    await writeFile(target, JSON.stringify(value));
    const event = page.waitForEvent("filechooser");
    await page.locator("#upload-trigger").focus();
    await page.keyboard.press("Enter");
    await (await event).setFiles(target);
    await page.waitForFunction(
      () =>
        document.querySelector("#status.error") ||
        document.querySelector("#status").textContent ===
          "Recipe replay complete.",
    );
    const message = await page.locator("#status").textContent();
    if (expectedError) {
      assert.match(message, expectedError);
      assert.equal(await page.locator("#download-portable").isDisabled(), true);
    } else {
      assert.equal(await page.locator("#status.error").count(), 0, message);
      await page.waitForFunction(
        () => !document.querySelector("#download-portable").disabled,
      );
    }
  }
  // Construct a real analyzed fixture with nondefault selection/profile/plateaus/reference.
  const analyzed = await page.evaluate(async () => {
    const { apiFetch } = await import("./api.js");
    const response = await apiFetch("/api/analyze", {
      method: "POST",
      body: JSON.stringify({
        file: "synthetic.gwy",
        channel: "0",
        operations: [{ name: "mean", params: {} }],
        selection: { roi: [0, 0, 2e-6, 2e-6], exclude_polygons: [] },
        profile: [
          [0.5e-6, 0.5e-6],
          [1.5e-6, 1.5e-6],
        ],
        plateaus: [
          [0, 0, 1e-6, 2e-6],
          [1e-6, 0, 2e-6, 2e-6],
        ],
        reference: { file: "synthetic.gwy", channel: "0" },
      }),
    });
    if (!response.ok) throw Error(JSON.stringify(await response.json()));
    return response.json();
  });
  await load(analyzed.recipe, "legacy-input.json");
  const legacy = await download("#download", "legacy-saved.json");
  assert.equal(legacy.schema_version, 1);
  const portable = await download("#download-portable", "portable.json");
  assert.equal(portable.kind, "afm_recipe_document");
  assert.equal(portable.schema_version, 2);
  assert.deepEqual(portable.recipe, legacy);
  assert.equal(portable.recipe_sha256, digest(legacy));
  const { document_sha256, ...unsigned } = portable;
  assert.equal(document_sha256, digest(unsigned));
  await page.locator("#reset-selection").click();
  assert.equal(await page.locator("#download-portable").isDisabled(), true);
  await load(reordered(portable), "reordered.json");
  const restored = await download("#download", "restored.json");
  assert.deepEqual(restored, legacy);
  assert.equal(restored.created_at, legacy.created_at);
  assert.deepEqual(restored.environment, legacy.environment);
  const state = await page.evaluate(async () => {
    const { getAnalysisSnapshot } = await import("./app.js");
    return getAnalysisSnapshot();
  });
  for (const key of [
    "operations",
    "selection",
    "profile",
    "plateaus",
    "reference",
  ])
    assert.deepEqual(state.recipe[key], legacy[key]);
  assert.equal(await page.locator("#compare").isChecked(), true);
  assert.equal(
    await page.locator("#reference-file").inputValue(),
    "synthetic.gwy",
  );
  // Recalculate from restored controls, proving state restoration beyond retained recipe metadata.
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  const recomputed = await download("#download", "recomputed.json");
  for (const key of [
    "operations",
    "selection",
    "profile",
    "plateaus",
    "reference",
    "output",
  ])
    assert.deepEqual(recomputed[key], legacy[key]);
  // Delay only migration dispatch so a viewer edit deterministically overlaps export.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === "recipe-document") {
        Worker.prototype.postMessage = original;
        const capturedMessage = structuredClone(message);
        setTimeout(() => original.call(this, capturedMessage, ...args), 150);
        return;
      }
      return original.call(this, message, ...args);
    };
  });
  const pendingPortable = page.waitForEvent("download");
  await page.locator("#download-portable").click();
  await page.locator("#reset-selection").click();
  const dirtyStatus = await page.locator("#status").textContent();
  const capturedFile = await pendingPortable;
  const capturedPath = join(scratch, "captured-during-edit.json");
  await capturedFile.saveAs(capturedPath);
  const capturedPortable = JSON.parse(await readFile(capturedPath, "utf8"));
  assert.deepEqual(capturedPortable.recipe, recomputed);
  assert.equal(await page.locator("#download-portable").isDisabled(), true);
  assert.equal(await page.locator("#status").textContent(), dirtyStatus);
  const corrupt = structuredClone(portable);
  corrupt.recipe.source.title = "tampered";
  await load(corrupt, "bad-checksum.json", /checksum|digest|hash|SHA/i);
  const geometry = structuredClone(legacy);
  geometry.source.geometry.xreal *= 2;
  await load(signed(geometry), "rehash-geometry.json", /calibration|geometry/i);
  const output = structuredClone(legacy);
  output.output.sha256 = "0".repeat(64);
  await load(signed(output), "rehash-output.json", /output|hash/i);
  const oversize = join(scratch, "oversize.json");
  await writeFile(oversize, " ".repeat(1024 * 1024 + 1));
  await page.locator("#upload").setInputFiles(oversize);
  await page.waitForFunction(() => document.querySelector("#status.error"));
  assert.match(await page.locator("#status").textContent(), /1 MiB/);
  await load(legacy, "legacy-again.json");
  assert.equal(
    (await download("#download", "legacy-again-saved.json")).schema_version,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      scratch,
      portableHash: portable.document_sha256,
      checks:
        "portable digests, recursive key reordering, restored processing/ROI/profile/plateaus/reference, metadata, rehashed tampering, dirty gate, size limit, keyboard input and legacy replay",
    }),
  );
} finally {
  await browser.close();
}
