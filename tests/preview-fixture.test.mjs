import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPreviewFixture,
  PREVIEW_EXAMPLE,
} from "../scripts/preview-fixture.mjs";
import { parseMeasurement } from "../web/formats.js";
import { analyze } from "../web/service.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const close = (actual, expected, tolerance = 1e-22) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );
test("preview metadata is frozen and fixture bytes deterministic and independently allocated", () => {
  assert.ok(Object.isFrozen(PREVIEW_EXAMPLE));
  assert.ok(Object.isFrozen(PREVIEW_EXAMPLE.shape));
  assert.deepEqual(PREVIEW_EXAMPLE, {
    file: "synthetic-step.gwy",
    channel: "0",
    shape: [16, 16],
    xreal: 8e-6,
    yreal: 8e-6,
    mean: 25e-9,
    min: 0,
    max: 50e-9,
    area: 64e-12,
  });
  const first = createPreviewFixture(),
    second = createPreviewFixture();
  assert.ok(Buffer.isBuffer(first));
  assert.deepEqual(first, second);
  assert.equal(
    digest(first),
    "070d5511c2b04a14a98dc9f9a5f720bc08b0c2e5b8f25a7cd403453698cd1f19",
  );
  first[0] = 0;
  assert.equal(second.toString("ascii", 0, 4), "GWYP");
});
test("real format reader retains calibrated row-major values and synthetic provenance", () => {
  const bytes = createPreviewFixture(),
    parsed = parseMeasurement(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  assert.equal(parsed.format, "GWYP");
  assert.deepEqual(Object.keys(parsed.channels), ["0"]);
  const c = parsed.channels["0"];
  assert.equal(c.title, "Synthetic height");
  assert.deepEqual(c.shape, [16, 16]);
  assert.equal(c.xreal, 8e-6);
  assert.equal(c.yreal, 8e-6);
  assert.equal(c.xoff, 0);
  assert.equal(c.yoff, 0);
  assert.equal(c.xy_unit, "m");
  assert.equal(c.z_unit, "m");
  assert.equal(
    c.metadata.Provenance,
    "Generated mathematical demonstration; not an instrument acquisition.",
  );
  close(c.data[7], 7e-9);
  close(c.data[8], 13e-9);
  close(c.data[16], 2e-9);
  close(c.data[255], 50e-9);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++)
      close(c.data[y * 16 + x], (x + 2 * y + (x >= 8 ? 5 : 0)) * 1e-9);
});
test("real analysis confirms known extrema mean area and explicit mean subtraction", async () => {
  const bytes = createPreviewFixture(),
    source = {
      ...parseMeasurement(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      ),
      sha256: digest(bytes),
    };
  const request = {
      file: PREVIEW_EXAMPLE.file,
      channel: PREVIEW_EXAMPLE.channel,
      operations: [],
    },
    raw = await analyze(request, source, null, "e".repeat(64));
  assert.equal(raw.statistics.valid_count, 256);
  assert.equal(raw.statistics.excluded_count, 0);
  close(raw.statistics.mean, PREVIEW_EXAMPLE.mean);
  close(raw.statistics.min, PREVIEW_EXAMPLE.min);
  close(raw.statistics.max, PREVIEW_EXAMPLE.max);
  close(raw.statistics.area, PREVIEW_EXAMPLE.area);
  const corrected = await analyze(
    { ...request, operations: [{ name: "mean" }] },
    source,
    null,
    "e".repeat(64),
  );
  close(corrected.statistics.mean, 0);
  close(corrected.statistics.min, -25e-9);
  close(corrected.statistics.max, 25e-9);
  close(corrected.statistics.area, 64e-12);
  assert.equal(corrected.statistics.valid_count, 256);
  assert.equal(
    corrected.channel.metadata.Provenance,
    source.channels["0"].metadata.Provenance,
  );
  assert.equal(source.channels["0"].data[0], 0);
});
