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

test("browser texture routes bind recipes, code identity, exports and tool artifacts", async (t) => {
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
  const post = async (path, body) =>
    apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  const bytes = fixture(),
    buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  assert.equal(
    (
      await apiFetch("/api/import", {
        body: [
          {
            name: "synthetic.gwy",
            size: bytes.length,
            arrayBuffer: async () => buffer,
          },
        ],
      })
    ).status,
    200,
  );
  const result = await (
    await post("/api/analyze", {
      file: "synthetic.gwy",
      channel: "0",
      operations: [],
      selection: { roi: [0, 0, 3e-6, 2e-6] },
    })
  ).json();
  assert.ok(result.recipe, JSON.stringify(result));
  const request = {
    recipe: result.recipe,
    parameters: { detrend: "mean", window: "boxcar" },
  };
  const report = await (await post("/api/texture", request)).json();
  assert.equal(report.kind, "spatial_texture", JSON.stringify(report));
  assert.equal(report.rasters, undefined);
  assert.deepEqual(report.input_recipe, result.recipe);
  const names = ["fft.js", "texture.js", "texture-service.js", "engine.js"];
  const parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  assert.deepEqual(report.code, {
    sha256: hash(parts.join("\n")),
    files: names.map((name, i) => ({ name, sha256: hash(parts[i]) })),
  });
  const exported = await post("/api/texture-export", {
    ...request,
    report_sha256: report.report_sha256,
  });
  assert.equal(exported.headers.get("Content-Type"), "application/x-tar");
  const tar = Buffer.from(await exported.arrayBuffer());
  assert.ok(tar.includes(Buffer.from(report.report_sha256)));
  assert.equal(
    (
      await post("/api/texture-export", {
        ...request,
        report_sha256: "a".repeat(64),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post("/api/texture", {
        ...request,
        parameters: { ...request.parameters, selection: {} },
      })
    ).status,
    400,
  );
  assert.equal(
    (await apiFetch("/api/texture", { body: JSON.stringify(request) })).status,
    400,
  );
  const tampered = structuredClone(request);
  tampered.recipe.output.sha256 = "b".repeat(64);
  assert.equal((await post("/api/texture", tampered)).status, 400);
  const changedParameters = {
    ...request,
    parameters: { detrend: "none", window: "boxcar" },
    report_sha256: report.report_sha256,
  };
  assert.equal(
    (await post("/api/texture-export", changedParameters)).status,
    400,
  );
  const args = {
    file: "synthetic.gwy",
    source_sha256: result.recipe.source.sha256,
    channel: "0",
    operations: [],
  };
  const analysis = await (
    await post("/api/tool", { name: "analyze_surface", arguments: args })
  ).json();
  assert.equal(analysis.record.status, "succeeded");
  const textureArgs = {
    file: args.file,
    source_sha256: args.source_sha256,
    recipe_artifact: analysis.artifact.id,
    parameters: {},
  };
  const tool = await (
    await post("/api/tool", { name: "measure_texture", arguments: textureArgs })
  ).json();
  assert.equal(tool.record.status, "succeeded", JSON.stringify(tool));
  assert.equal(tool.artifact.content.result.kind, "spatial_texture");
  assert.equal(tool.artifact.content.result.rasters, undefined);
  const failed = await (
    await post("/api/tool", {
      name: "measure_texture",
      arguments: { ...textureArgs, source_sha256: "f".repeat(64) },
    })
  ).json();
  assert.equal(failed.record.status, "failed");
  await apiFetch("/api/import", {
    body: [
      {
        name: "other.gwy",
        size: bytes.length,
        arrayBuffer: async () => buffer,
      },
    ],
  });
  const crossFile = await (
    await post("/api/tool", {
      name: "measure_texture",
      arguments: { ...textureArgs, file: "other.gwy" },
    })
  ).json();
  assert.equal(crossFile.record.status, "failed");
  assert.match(crossFile.record.error, /bound source/);
});
