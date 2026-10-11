import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
import { analyze } from "../web/service.js";
const exec = promisify(execFile);
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
function entries(bytes) {
  const result = {};
  for (let i = 0; i + 512 <= bytes.length; ) {
    const header = bytes.subarray(i, i + 512);
    const name = Buffer.from(header.subarray(0, 100)).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
      Buffer.from(header.subarray(124, 136)).toString().replace(/\0/g, ""),
      8,
    );
    result[name] = Buffer.from(
      bytes.subarray(i + 512, i + 512 + size),
    ).toString();
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}
test("worker batch routes gate calibration, retain provenance and verify exported replay", async (t) => {
  const oldSelf = globalThis.self,
    oldFetch = globalThis.fetch;
  let posted;
  globalThis.self = {
    postMessage: (message) => {
      posted = message;
    },
  };
  globalThis.fetch = async (url) => new Response(await readFile(url, "utf8"));
  t.after(() => {
    globalThis.self = oldSelf;
    globalThis.fetch = oldFetch;
  });
  await import("../web/worker.js?batch-integration");
  let id = 0;
  const call = async (type, payload) => {
    const requestId = ++id;
    await self.onmessage({ data: { id: requestId, type, payload } });
    assert.equal(posted.id, requestId);
    if (posted.error) throw new Error(posted.error);
    return posted.result;
  };
  for (const [name, offset, unit] of [
    ["a.gwy", 0, "m"],
    ["b.gwy", 1e-9, "m"],
    ["volts.gwy", 0, "V"],
  ]) {
    const bytes = fixture(offset, unit);
    await call("import", {
      name,
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.length,
      ),
    });
  }
  const template = (
    await call("analyze", {
      file: "a.gwy",
      channel: "0",
      operations: [{ name: "zero_min", params: {} }],
    })
  ).recipe;
  const checked = await call("batch-check", { file: "b.gwy", template });
  assert.equal(checked.compatible, true);
  assert.match(checked.source_sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    call("batch-check", { file: "volts.gwy", template }),
    /geometry.*z_unit/,
  );
  await assert.rejects(
    call("batch-run", {
      file: "b.gwy",
      template: { ...template, reference: { file: "a.gwy", channel: "0" } },
    }),
    /reference comparison/,
  );
  const result = await call("batch-run", { file: "b.gwy", template });
  assert.equal(result.recipe.source.sha256, checked.source_sha256);
  assert.notEqual(result.recipe.source.sha256, template.source.sha256);
  assert.deepEqual(result.recipe.operations, template.operations);
  assert.equal(result.recipe.reference, null);
  assert.equal(result.recipe.engine.sha256, await engineIdentity("GWYP"));
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.support);
  assert.equal(result.data, undefined);
  const archive = entries(
    await call("batch-export", { file: "b.gwy", recipe: result.recipe }),
  );
  assert.deepEqual(JSON.parse(archive["recipe.json"]), result.recipe);
  assert.deepEqual(
    JSON.parse(archive["analysis.json"]).statistics,
    result.statistics,
  );
  assert.ok(archive["surface.tsv"]);
  await assert.rejects(
    call("batch-export", { file: "a.gwy", recipe: result.recipe }),
    /Source SHA-256 mismatch/,
  );
  const mislabeled = structuredClone(result.recipe);
  mislabeled.source.title = "Different signal";
  await assert.rejects(
    call("batch-export", { file: "b.gwy", recipe: mislabeled }),
    /title or ID/,
  );
  const catalog = await call("tools", {});
  assert.equal(catalog.version, "1.0.0");
  assert.equal(catalog.tools.length, 7);
  const inspected = await call("tool", {
    name: "inspect_source",
    arguments: { file: "a.gwy" },
  });
  assert.equal(inspected.record.status, "succeeded");
  const toolSource = inspected.artifact.content.result;
  assert.equal(toolSource.sha256, template.source.sha256);
  const analyzed = await call("tool", {
    name: "analyze_surface",
    arguments: {
      file: "a.gwy",
      source_sha256: toolSource.sha256,
      channel: "0",
      operations: template.operations,
    },
  });
  assert.equal(
    analyzed.record.status,
    "succeeded",
    JSON.stringify(analyzed.record),
  );
  assert.equal(
    analyzed.artifact.content.result.recipe.output.sha256,
    template.output.sha256,
  );
  assert.equal(analyzed.artifact.content.result.data, undefined);
  const verified = await call("tool", {
    name: "replay_recipe",
    arguments: {
      file: "a.gwy",
      source_sha256: toolSource.sha256,
      recipe_artifact: analyzed.artifact.id,
    },
  });
  assert.equal(
    verified.record.status,
    "succeeded",
    JSON.stringify(verified.record),
  );
  assert.equal(verified.artifact.content.result.replay_verified, true);
  const diagnostics = await call("tool", {
    name: "check_quality",
    arguments: {
      file: "a.gwy",
      source_sha256: toolSource.sha256,
      channel: "0",
    },
  });
  assert.equal(
    diagnostics.record.status,
    "succeeded",
    JSON.stringify(diagnostics.record),
  );
  assert.equal(diagnostics.artifact.content.result.report.counts.total, 6);
  const stale = await call("tool", {
    name: "analyze_surface",
    arguments: {
      file: "a.gwy",
      source_sha256: "0".repeat(64),
      channel: "0",
      operations: [],
    },
  });
  assert.equal(stale.record.status, "failed");
  assert.match(stale.record.error, /SHA-256 mismatch/);
  const journal = await call("tool-journal", {});
  assert.equal(journal.records.length, 5);
  assert.equal(journal.records[4].previous_sha256, journal.records[3].sha256);
  assert.deepEqual(
    await call("tool-artifact", { artifact_id: analyzed.artifact.id }),
    analyzed.artifact,
  );
  const segmented = await call("tool", {
    name: "segment_surface",
    arguments: {
      file: "a.gwy",
      source_sha256: toolSource.sha256,
      recipe_artifact: analyzed.artifact.id,
      parameters: { threshold: 3e-9 },
    },
  });
  assert.equal(
    segmented.record.status,
    "succeeded",
    JSON.stringify(segmented.record),
  );
  const segmentation = segmented.artifact.content.result;
  assert.equal(segmentation.report.counts.accepted_pixels, 3);
  assert.equal(segmentation.report.regions.length, 1);
  assert.equal(
    segmentation.labels,
    undefined,
    "Tool artifacts keep compact metadata, not raster labels",
  );
  assert.equal(segmentation.input_recipe.output.sha256, template.output.sha256);
  const directSegmentation = await call("segment", {
    recipe: analyzed.artifact.content.result.recipe,
    parameters: { threshold: 3e-9 },
  });
  assert.deepEqual(directSegmentation.labels, [0, 0, 0, 1, 1, 1]);
  assert.equal(directSegmentation.report_sha256, segmentation.report_sha256);
  assert.equal(directSegmentation.labels_sha256, segmentation.labels_sha256);
  const wrongSegmentation = await call("tool", {
    name: "segment_surface",
    arguments: {
      file: "b.gwy",
      source_sha256: checked.source_sha256,
      recipe_artifact: analyzed.artifact.id,
      parameters: { threshold: 3e-9 },
    },
  });
  assert.equal(wrongSegmentation.record.status, "failed");
  assert.match(wrongSegmentation.record.error, /bound source/);
  const altered = structuredClone(result.recipe);
  altered.output.sha256 = "0".repeat(64);
  await assert.rejects(
    call("batch-export", { file: "b.gwy", recipe: altered }),
    /Replay output differs/,
  );
});
test("CLI shared batch gate preserves resume and rejects reference templates explicitly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-batch-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.gwy"),
    templatePath = join(dir, "template.json"),
    out = join(dir, "out");
  await writeFile(input, fixture());
  const source = await loadSource(input);
  const result = await analyze(
    { file: "input.gwy", channel: "0", operations: [] },
    source,
    null,
    await engineIdentity("GWYP"),
  );
  await writeFile(templatePath, JSON.stringify(result.recipe));
  const args = ["scripts/afm.mjs", "batch", templatePath, input, "--out", out];
  await exec(process.execPath, args);
  let report = JSON.parse(await readFile(join(out, "batch.json"), "utf8"));
  assert.equal(report.records[0].status, "complete");
  await exec(process.execPath, [...args, "--resume"]);
  report = JSON.parse(await readFile(join(out, "batch.json"), "utf8"));
  assert.equal(report.records[0].resumed, true);
  assert.equal(report.records[0].output_sha256, result.recipe.output.sha256);
  assert.ok(report.records[0].support);
  assert.ok(Array.isArray(report.records[0].warnings));
  await writeFile(
    templatePath,
    JSON.stringify({
      ...result.recipe,
      reference: { file: "input.gwy", channel: "0" },
    }),
  );
  await assert.rejects(exec(process.execPath, args), (error) =>
    /must not contain a reference comparison/.test(error.stderr),
  );
  assert.deepEqual(await readFile(input), fixture());
});
