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

test("registration routes replay both recipes and verify explicit transform exports", async (t) => {
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
  async function input(name, bytes) {
    const response = await apiFetch("/api/import", {
      body: [
        {
          name,
          size: bytes.length,
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        },
      ],
    });
    assert.equal(response.status, 200);
    const analyzed = await (
      await post("/api/analyze", { file: name, channel: "0", operations: [] })
    ).json();
    assert.ok(analyzed.recipe, JSON.stringify(analyzed));
    return analyzed.recipe;
  }
  const fixed = await input("fixed.gwy", fixture()),
    moving = await input("moving.gwy", fixture(2e-9));
  const request = {
    fixed_recipe: fixed,
    moving_recipe: moving,
    parameters: { mode: "manual", tx: 1e-6, ty: 0, interpolation: "nearest" },
  };
  const response = await post("/api/registration", request),
    report = await response.json();
  assert.equal(response.status, 200, JSON.stringify(report));
  assert.equal(report.kind, "translation_registration");
  assert.deepEqual(report.input_recipes, { fixed, moving });
  assert.equal(report.metrics.valid_count, 4);
  assert.ok(Math.abs(report.metrics.rmse - 1e-9) < 1e-22);
  assert.equal(report.transform.tx, 1e-6);
  assert.equal(report.rasters, undefined);
  const names = ["registration.js", "registration-service.js", "engine.js"];
  const parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  const hash = (v) => createHash("sha256").update(v).digest("hex");
  assert.deepEqual(report.code, {
    sha256: hash(parts.join("\n")),
    files: names.map((name, i) => ({ name, sha256: hash(parts[i]) })),
  });
  const exportRequest = { ...request, report_sha256: report.report_sha256 };
  const exported = await post("/api/registration-export", exportRequest);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("Content-Type"), "application/x-tar");
  const bytes = Buffer.from(await exported.arrayBuffer());
  const entries = {};
  for (let offset = 0; offset < bytes.length - 1024; ) {
    const header = bytes.subarray(offset, offset + 512),
      name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
      header.subarray(124, 136).toString().replace(/\0/g, ""),
      8,
    );
    entries[name] = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(JSON.parse(entries["report.json"]), report);
  for (const array of Object.values(report.arrays))
    assert.equal(hash(entries[array.file]), array.sha256);
  for (const bad of [
    { ...exportRequest, report_sha256: "a".repeat(64) },
    { ...exportRequest, parameters: { ...request.parameters, tx: 0 } },
  ])
    assert.equal((await post("/api/registration-export", bad)).status, 400);
  assert.equal(
    (await apiFetch("/api/registration", { body: JSON.stringify(request) }))
      .status,
    400,
  );
  for (const field of ["fixed_recipe", "moving_recipe"]) {
    const bad = structuredClone(request);
    bad[field].output.sha256 = "b".repeat(64);
    assert.equal((await post("/api/registration", bad)).status, 400);
  }
  assert.equal(
    (
      await post("/api/registration", {
        ...request,
        parameters: { ...request.parameters, moving_selection: {} },
      })
    ).status,
    400,
  );
  const voltage = await input("voltage.gwy", fixture(0, "V"));
  assert.equal(
    (await post("/api/registration", { ...request, moving_recipe: voltage }))
      .status,
    400,
  );
  const automatic = await (
    await post("/api/registration", {
      fixed_recipe: fixed,
      moving_recipe: fixed,
      parameters: {
        mode: "automatic",
        radius_x: 1,
        radius_y: 1,
        min_overlap_fraction: 0.5,
      },
    })
  ).json();
  assert.equal(
    automatic.kind,
    "translation_registration",
    JSON.stringify(automatic),
  );
  assert.deepEqual(automatic.transform.pixel_shift, [0, 0]);
  assert.equal(automatic.metrics.rmse, 0);
});
