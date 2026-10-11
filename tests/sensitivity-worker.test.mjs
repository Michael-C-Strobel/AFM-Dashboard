import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
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

test("sensitivity worker preserves variants and verifies saved evidence before exports", async (t) => {
  const oldFetch = globalThis.fetch,
    oldSelf = globalThis.self,
    oldWorker = globalThis.Worker;
  t.after(() => {
    globalThis.fetch = oldFetch;
    globalThis.self = oldSelf;
    globalThis.Worker = oldWorker;
  });
  globalThis.fetch = async (url) =>
    String(url).endsWith("/data/manifest.json")
      ? Response.json({ files: [] })
      : new Response(await readFile(url));
  let worker;
  globalThis.self = {
    postMessage: (message) => worker.onmessage({ data: message }),
  };
  await import("../web/worker.js");
  globalThis.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage(data) {
      self.onmessage({ data });
    }
  };
  const { apiFetch } = await import("../web/api.js");
  const post = (path, body) =>
    apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  const bytes = fixture(),
    buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  await apiFetch("/api/import", {
    body: [
      {
        name: "sensitivity.gwy",
        size: bytes.length,
        arrayBuffer: async () => buffer,
      },
    ],
  });
  const analysis = await (
    await post("/api/analyze", {
      file: "sensitivity.gwy",
      channel: "0",
      operations: [],
    })
  ).json();
  const variants = [
    {
      id: "mean",
      label: "Mean removed",
      operations: [{ name: "mean", params: {} }],
      selection: {},
    },
    {
      id: "roi",
      label: "Left columns",
      operations: [],
      selection: { roi: [0, 0, 2e-6, 2e-6] },
    },
    {
      id: "outside",
      label: "Empty ROI",
      operations: [],
      selection: { roi: [10, 10, 11, 11] },
    },
  ];
  const assumptions = {
    calibration_note: "No certificate supplied",
    model_note: "Deterministic processing choices",
  };
  const request = { baseline_recipe: analysis.recipe, variants, assumptions };
  const response = await post("/api/sensitivity", request),
    report = await response.json();
  assert.equal(response.status, 200, JSON.stringify(report));
  assert.equal(report.kind, "analysis_sensitivity");
  assert.equal(report.status, "partial");
  assert.deepEqual(
    report.variants.map((v) => v.status),
    ["succeeded", "succeeded", "failed"],
  );
  assert.equal(report.variants[0].result.recipe.operations[0].name, "mean");
  assert.equal(report.variants[1].result.statistics.valid_count, 4);
  assert.equal(report.baseline.statistics.valid_count, 6);
  assert.equal(report.variants[0].result.data, undefined);
  const hash = (v) => createHash("sha256").update(v).digest("hex");
  const names = ["sensitivity.js", "sensitivity-service.js", "engine.js"];
  const parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  assert.deepEqual(report.code, {
    sha256: hash(parts.join("\n")),
    files: names.map((name, i) => ({ name, sha256: hash(parts[i]) })),
  });
  const unsigned = structuredClone(report);
  delete unsigned.report_sha256;
  assert.equal(hash(JSON.stringify(unsigned)), report.report_sha256);
  const exported = await post("/api/sensitivity-export", {
    report,
    format: "tar",
  });
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.equal(exported.headers.get("Content-Type"), "application/x-tar");
  const tar = Buffer.from(await exported.arrayBuffer());
  assert.ok(tar.includes(Buffer.from(report.report_sha256)));
  const tsv = await post("/api/sensitivity-export", { report, format: "tsv" });
  assert.equal(tsv.status, 200);
  const table = await tsv.text();
  assert.match(table, /outside/);
  assert.ok(table.includes(report.report_sha256));
  assert.ok(table.includes(analysis.recipe.source.sha256));
  const tampered = structuredClone(report);
  tampered.variants[0].result.statistics.sa = 123;
  const rehash = structuredClone(tampered);
  delete rehash.report_sha256;
  tampered.report_sha256 = hash(JSON.stringify(rehash));
  assert.equal(
    (await post("/api/sensitivity-export", { report: tampered, format: "tar" }))
      .status,
    400,
  );
  assert.equal(
    (await post("/api/sensitivity-export", { report, format: "csv" })).status,
    400,
  );
  assert.equal(
    (await apiFetch("/api/sensitivity", { body: JSON.stringify(request) }))
      .status,
    400,
  );
  const analyzed = await (
    await post("/api/tool", {
      name: "analyze_surface",
      arguments: {
        file: "sensitivity.gwy",
        source_sha256: analysis.recipe.source.sha256,
        channel: "0",
        operations: [],
      },
    })
  ).json();
  const args = {
    file: "sensitivity.gwy",
    source_sha256: analysis.recipe.source.sha256,
    recipe_artifact: analyzed.artifact.id,
    variants,
    assumptions,
  };
  const tool = await (
    await post("/api/tool", { name: "analyze_sensitivity", arguments: args })
  ).json();
  assert.equal(tool.record.status, "succeeded", JSON.stringify(tool));
  assert.equal(tool.artifact.content.result.status, "partial");
  const failed = await (
    await post("/api/tool", {
      name: "analyze_sensitivity",
      arguments: { ...args, source_sha256: "a".repeat(64) },
    })
  ).json();
  assert.equal(failed.record.status, "failed");
});
