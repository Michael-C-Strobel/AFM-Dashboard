import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { canonicalRecipeJSON } from "../web/recipe-interchange.js";
import { sha256 } from "../web/engine.js";
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

const reverse = (v) =>
  Array.isArray(v)
    ? v.map(reverse)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, reverse(x)]),
        )
      : v;
async function resign(d) {
  d.recipe_sha256 = await sha256(
    new TextEncoder().encode(canonicalRecipeJSON(d.recipe)),
  );
  delete d.document_sha256;
  d.document_sha256 = await sha256(
    new TextEncoder().encode(canonicalRecipeJSON(d)),
  );
  return d;
}
test("portable recipe worker/API verifies JSON transport and retained scientific settings", async (t) => {
  const old = {
    fetch: globalThis.fetch,
    self: globalThis.self,
    Worker: globalThis.Worker,
  };
  t.after(() => Object.assign(globalThis, old));
  globalThis.fetch = async (url) =>
    String(url).endsWith("/data/manifest.json")
      ? Response.json({ files: [] })
      : new Response(await readFile(url));
  let worker;
  const requests = [],
    responses = [];
  globalThis.self = {
    postMessage(message, transfer) {
      responses.push({ message, transfer });
      worker.onmessage({ data: message });
    },
  };
  await import("../web/worker.js");
  globalThis.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage(data) {
      requests.push(data);
      self.onmessage({ data });
    }
  };
  const { apiFetch } = await import("../web/api.js");
  const post = (path, body) =>
    apiFetch(path, { method: "POST", body: JSON.stringify(body) });
  for (const [name, offset] of [
    ["raw.gwy", 0],
    ["ref.gwy", 1e-9],
  ]) {
    const bytes = fixture(offset),
      buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    assert.equal(
      (
        await apiFetch("/api/import", {
          body: [{ name, size: bytes.length, arrayBuffer: async () => buffer }],
        })
      ).status,
      200,
    );
  }
  const request = {
    file: "raw.gwy",
    channel: "0",
    operations: [{ name: "mean" }],
    selection: { roi: [0, 0, 3e-6, 2e-6], exclude_polygons: [] },
    profile: [
      [0.5e-6, 0.5e-6],
      [2.5e-6, 1.5e-6],
    ],
    plateaus: [
      [0, 0, 1e-6, 2e-6],
      [2e-6, 0, 3e-6, 2e-6],
    ],
    reference: { file: "ref.gwy", channel: "0" },
  };
  const analysisResponse = await post("/api/analyze", request);
  assert.match(
    analysisResponse.headers.get("content-type"),
    /application\/json/,
  );
  const analysis = await analysisResponse.json();
  assert.ok(analysis.recipe, JSON.stringify(analysis));
  const legacyResponse = await post("/api/replay", { recipe: analysis.recipe });
  assert.equal(legacyResponse.status, 200);
  const legacy = await legacyResponse.json();
  assert.equal(legacy.replay_verified, true);
  assert.deepEqual(legacy.data, analysis.data);
  assert.equal(legacy.interchange, undefined);
  for (const options of [
    { body: JSON.stringify({ recipe: analysis.recipe }) },
    { method: "GET", body: JSON.stringify({ recipe: analysis.recipe }) },
    {
      method: "POST",
      body: JSON.stringify({ recipe: analysis.recipe, extra: true }),
    },
    { method: "POST", body: "{}" },
  ])
    assert.equal((await apiFetch("/api/recipe-document", options)).status, 400);
  const exported = await post("/api/recipe-document", {
    recipe: analysis.recipe,
  });
  assert.equal(exported.status, 200);
  const document = await exported.json();
  assert.equal(document.kind, "afm_recipe_document");
  assert.equal(document.schema_version, 2);
  assert.equal(document.recipe.created_at, analysis.recipe.created_at);
  assert.deepEqual(document.recipe.environment, analysis.recipe.environment);
  const response = await post("/api/replay", { recipe: reverse(document) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const replayed = await response.json();
  assert.equal(replayed.replay_verified, true);
  assert.deepEqual(replayed.recipe, analysis.recipe);
  assert.deepEqual(replayed.data, analysis.data);
  assert.deepEqual(replayed.statistics, analysis.statistics);
  for (const key of ["selection", "profile", "plateaus", "reference"])
    assert.deepEqual(replayed.recipe[key], analysis.recipe[key]);
  assert.deepEqual(replayed.profile, analysis.profile);
  assert.deepEqual(replayed.step, analysis.step);
  assert.deepEqual(replayed.comparison, analysis.comparison);
  assert.equal(replayed.interchange.document_sha256, document.document_sha256);
  const surfaceRequests = requests.filter((r) =>
    ["analyze", "replay"].includes(r.type),
  );
  assert.ok(surfaceRequests.length >= 3);
  for (const req of surfaceRequests) {
    assert.equal(req.responseEncoding, "json");
    const sent = responses.find((r) => r.message.id === req.id);
    assert.ok(sent.message.result instanceof Uint8Array);
    assert.equal(sent.transfer[0], sent.message.result.buffer);
    assert.equal(
      JSON.parse(new TextDecoder().decode(sent.message.result)).recipe
        .schema_version,
      1,
    );
  }
  for (const change of [
    (r) => (r.output.measurement_sha256 = "b".repeat(64)),
    (r) => (r.source.title = "Other"),
    (r) => (r.reference.sha256 = "b".repeat(64)),
    (r) => (r.source.geometry.xreal = 9e-6),
    (r) => (r.operations = []),
  ]) {
    const changed = structuredClone(document);
    change(changed.recipe);
    assert.equal(
      (await post("/api/replay", { recipe: await resign(changed) })).status,
      400,
    );
  }
  assert.equal(
    (await post("/api/replay", { recipe: reverse(analysis.recipe) })).status,
    400,
  );
});
