import test from "node:test";
import assert from "node:assert/strict";
import { analyze, replay } from "../web/service.js";
import { sha256 } from "../web/engine.js";
import {
  canonicalRecipeJSON,
  normalizeLegacyRecipe,
  decodeRecipeInput,
  migrateRecipe,
  replayRecipeInput,
} from "../web/recipe-interchange.js";
const engine = "e".repeat(64);
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
async function fixture({ missing = false, reference = false } = {}) {
  const channel = {
    id: "0",
    title: "Synthetic height",
    width: 4,
    height: 3,
    xreal: 4,
    yreal: 3,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data: Float64Array.from(
      { length: 12 },
      (_, i) => 7 + (i % 4) + 2 * Math.floor(i / 4),
    ),
    mask: null,
    metadata: {},
    log: [],
    warnings: [],
    selections: {},
  };
  if (missing) {
    channel.data[0] = NaN;
    channel.mask = Uint8Array.from({ length: 12 }, (_, i) => (i === 1 ? 1 : 0));
  }
  const source = {
    channels: { 0: channel },
    sha256: "a".repeat(64),
    unsupported: [],
    warnings: [],
  };
  const ref = reference ? structuredClone(source) : null;
  const result = await analyze(
    {
      file: "sample.gwy",
      channel: "0",
      operations: [{ name: "mean" }],
      selection: {},
      reference: reference ? { file: "ref.gwy", channel: "0" } : null,
    },
    source,
    ref,
    engine,
  );
  return { source, reference: ref, recipe: result.recipe, result };
}
async function resign(document) {
  const d = structuredClone(document);
  d.recipe_sha256 = await sha256(
    new TextEncoder().encode(canonicalRecipeJSON(d.recipe)),
  );
  delete d.document_sha256;
  d.document_sha256 = await sha256(
    new TextEncoder().encode(canonicalRecipeJSON(d)),
  );
  return d;
}
test("portable recursive key reordering verifies and replays with original metadata", async () => {
  const f = await fixture(),
    before = structuredClone(f.recipe),
    d = await migrateRecipe(reverse(f.recipe), f.source, null, engine);
  const decoded = await decodeRecipeInput(reverse(d));
  assert.deepEqual(decoded.recipe, before);
  const r = await replayRecipeInput(reverse(d), f.source, null, engine);
  assert.equal(r.replay_verified, true);
  assert.deepEqual(r.data, f.result.data);
  assert.deepEqual(r.recipe, before);
  assert.equal(r.interchange.document_sha256, d.document_sha256);
  assert.deepEqual(f.recipe, before);
  assert.equal(canonicalRecipeJSON(d), canonicalRecipeJSON(reverse(d)));
});
test("legacy decode preserves original order and core order-sensitive behavior", async () => {
  const f = await fixture(),
    r = reverse(f.recipe),
    decoded = await decodeRecipeInput(r);
  assert.equal(decoded.document, null);
  assert.equal(JSON.stringify(decoded.recipe), JSON.stringify(r));
  await assert.rejects(
    replay(r, f.source, null, engine),
    /calibration mismatch/,
  );
  await assert.rejects(
    replayRecipeInput(r, f.source, null, engine),
    /calibration mismatch/,
  );
  assert.equal(
    (await replayRecipeInput(f.recipe, f.source, null, engine, "renamed.gwy"))
      .recipe.source.file,
    "renamed.gwy",
  );
});
test("missing pixels masks profile plateau and reference settings remain exact", async () => {
  const f = await fixture({ missing: true, reference: true });
  const d = await migrateRecipe(f.recipe, f.source, f.reference, engine),
    r = await replayRecipeInput(d, f.source, f.reference, engine);
  assert.deepEqual(r.data, f.result.data);
  assert.deepEqual(r.recipe.reference, f.recipe.reference);
  assert.ok(r.recipe.output.mask_sha256);
  const ordinary = await fixture();
  const out = await analyze(
    {
      file: "sample.gwy",
      channel: "0",
      operations: [],
      profile: [
        [0.5, 0.5],
        [3.5, 2.5],
      ],
      plateaus: [
        [0, 0, 2, 3],
        [2, 0, 4, 3],
      ],
    },
    ordinary.source,
    null,
    engine,
  );
  assert.deepEqual(
    (
      await replayRecipeInput(
        await migrateRecipe(out.recipe, ordinary.source, null, engine),
        ordinary.source,
        null,
        engine,
      )
    ).recipe,
    out.recipe,
  );
  for (const plateaus of [
    [null, null],
    [null, [0, 0, 1, 1]],
  ])
    assert.deepEqual(
      normalizeLegacyRecipe({ ...ordinary.recipe, plateaus }).plateaus,
      plateaus,
    );
});
test("strict schemas reject every missing root field and nested unknown fields", async () => {
  const f = await fixture();
  for (const key of Object.keys(f.recipe)) {
    const r = structuredClone(f.recipe);
    delete r[key];
    assert.throws(() => normalizeLegacyRecipe(r), /fields/);
  }
  for (const target of [
    "engine",
    "source",
    "output",
    "environment",
    "selection",
  ]) {
    const r = structuredClone(f.recipe);
    r[target].unknown = 1;
    assert.throws(() => normalizeLegacyRecipe(r), /fields/);
  }
  const d = await migrateRecipe(f.recipe, f.source, null, engine);
  for (const key of Object.keys(d)) {
    const changed = structuredClone(d);
    delete changed[key];
    await assert.rejects(decodeRecipeInput(changed));
  }
  await assert.rejects(decodeRecipeInput({ ...d, unknown: 1 }));
  for (const change of [
    (r) => (r.engine.name = "other"),
    (r) => (r.engine.version = "0.2.0"),
    (r) => (r.source.file = "../data.gwy"),
    (r) => (r.source.file = "."),
    (r) => (r.source.channel = ""),
    (r) => (r.source.geometry.shape = [0, 2]),
    (r) => (r.source.geometry.xy_unit = 1),
    (r) => (r.source.geometry.xreal = 0),
    (r) => (r.output.sha256 = "A".repeat(64)),
    (r) => (r.random_seed = 1),
    (r) => (r.created_at = "2025-02-30T00:00:00Z"),
    (r) => (r.created_at = "yesterday"),
    (r) => (r.profile = [[0, 0]]),
    (r) => (r.plateaus = [[0, 0, 0, 1], null]),
    (r) => (r.selection = { roi: null }),
    (r) => (r.operations = [{ name: "robust_plane", params: {} }]),
  ]) {
    const r = structuredClone(f.recipe);
    change(r);
    assert.throws(() => normalizeLegacyRecipe(r));
  }
});
test("document version canonicalization digest and array tampering reject", async () => {
  const f = await fixture(),
    d = await migrateRecipe(f.recipe, f.source, null, engine);
  for (const patch of [
    { kind: "other" },
    { schema_version: 3 },
    { canonicalization: "RFC" },
    { recipe_sha256: "f".repeat(64) },
    { document_sha256: "f".repeat(64) },
  ])
    await assert.rejects(decodeRecipeInput({ ...d, ...patch }));
  const changed = structuredClone(d);
  changed.recipe.source.geometry.shape.reverse();
  await assert.rejects(decodeRecipeInput(changed), /checksum/);
  assert.notEqual(canonicalRecipeJSON([1, 2]), canonicalRecipeJSON([2, 1]));
});
test("independently rehashed scientific tampering fails replay binding", async () => {
  const f = await fixture({ reference: true }),
    d = await migrateRecipe(f.recipe, f.source, f.reference, engine);
  for (const change of [
    (r) => (r.source.sha256 = "b".repeat(64)),
    (r) => (r.source.title = "Wrong"),
    (r) => (r.source.channel = "1"),
    (r) => (r.source.geometry.xreal = 5),
    (r) => (r.source.geometry.z_unit = "V"),
    (r) => (r.engine.sha256 = "b".repeat(64)),
    (r) => (r.reference.sha256 = "b".repeat(64)),
    (r) => (r.output.sha256 = "b".repeat(64)),
    (r) => (r.output.mask_sha256 = "b".repeat(64)),
    (r) => (r.output.measurement_sha256 = "b".repeat(64)),
    (r) => (r.output.geometry.yoff = 4),
    (r) => (r.operations = []),
  ]) {
    const edited = structuredClone(d);
    change(edited.recipe);
    await assert.rejects(
      replayRecipeInput(await resign(edited), f.source, f.reference, engine),
    );
  }
  await assert.rejects(
    replayRecipeInput(d, f.source, f.reference, engine, "other.gwy"),
    /filename/,
  );
  await assert.rejects(
    migrateRecipe(
      { ...f.recipe, source: { ...f.recipe.source, title: "Wrong" } },
      f.source,
      f.reference,
      engine,
    ),
    /title/,
  );
});
test("JSON guard never invokes getters and rejects nonplain nonfinite cycles and limits", () => {
  let invoked = false;
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  assert.throws(() => canonicalRecipeJSON(getter));
  assert.equal(invoked, false);
  for (const value of [
    NaN,
    Infinity,
    undefined,
    1n,
    () => 1,
    new Date(),
    new Map(),
    Object.create({ x: 1 }),
    [1, , 3],
    Object.assign([1], { extra: 2 }),
    { [Symbol("x")]: 1 },
  ])
    assert.throws(() => canonicalRecipeJSON(value));
  const cycle = {};
  cycle.x = cycle;
  assert.throws(() => canonicalRecipeJSON(cycle));
  const hidden = {};
  Object.defineProperty(hidden, "x", { value: 1 });
  assert.throws(() => canonicalRecipeJSON(hidden));
  let deep = {};
  for (let i = 0; i < 66; i++) deep = { x: deep };
  assert.throws(() => canonicalRecipeJSON(deep), /depth/);
  assert.throws(() => canonicalRecipeJSON("é".repeat(600000)), /MiB/);
  assert.equal(
    canonicalRecipeJSON({ "\uE000": 1, "😀": 2, a: 3 }),
    '{"a":3,"😀":2,"":1}',
  );
});
test("async migration decoding and replay snapshot all caller-owned evidence", async () => {
  const f = await fixture(),
    original = structuredClone(f.recipe),
    p = migrateRecipe(f.recipe, f.source, null, engine);
  f.recipe.created_at = "mutated";
  f.source.channels[0].data.fill(99);
  const d = await p;
  assert.equal(d.recipe.created_at, original.created_at);
  const decoding = decodeRecipeInput(d);
  d.recipe.source.title = "mutated";
  const decoded = await decoding;
  assert.equal(decoded.recipe.source.title, original.source.title);
  const fresh = await fixture(),
    document = await migrateRecipe(fresh.recipe, fresh.source, null, engine),
    replaying = replayRecipeInput(document, fresh.source, null, engine);
  document.recipe.source.title = "mutated";
  fresh.source.channels[0].data.fill(99);
  assert.equal((await replaying).recipe.source.title, original.source.title);
});

test("bounds reject oversized operation lists malformed references and nonplain arrays", async () => {
  const f = await fixture();
  const tooMany = {
    ...f.recipe,
    operations: Array.from({ length: 33 }, () => ({
      name: "mean",
      params: {},
    })),
  };
  assert.throws(() => normalizeLegacyRecipe(tooMany));
  for (const reference of [
    { file: "ref.gwy", channel: "0", sha256: "a".repeat(64), extra: 1 },
    { file: "ref.gwy", channel: 0, sha256: "a".repeat(64) },
    { file: "ref.gwy", channel: "0", sha256: "A".repeat(64) },
  ])
    assert.throws(() => normalizeLegacyRecipe({ ...f.recipe, reference }));
  assert.throws(() =>
    normalizeLegacyRecipe({
      ...f.recipe,
      created_at: f.recipe.created_at + "\n",
    }),
  );
  class CustomArray extends Array {}
  assert.throws(() => canonicalRecipeJSON(new CustomArray(1, 2)));
  let invoked = false;
  const bad = structuredClone(f.recipe);
  Object.defineProperty(bad.source, "title", {
    enumerable: true,
    get() {
      invoked = true;
      return "Synthetic height";
    },
  });
  await assert.rejects(migrateRecipe(bad, f.source, null, engine));
  await assert.rejects(decodeRecipeInput(bad));
  assert.equal(invoked, false);
});
