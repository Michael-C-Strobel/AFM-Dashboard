import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { segmentRecipe } from "../web/segmentation-service.js";
import { analyze } from "../web/service.js";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
const exec = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const engine = "e".repeat(64);
async function identity() {
  const names = ["segmentation.js", "segmentation-service.js", "engine.js"];
  const parts = await Promise.all(
    names.map((name) =>
      readFile(new URL("../web/" + name, import.meta.url), "utf8"),
    ),
  );
  return {
    sha256: digest(parts.join("\n")),
    files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
  };
}
async function analyzed() {
  const data = new Float64Array(25);
  for (const i of [6, 7, 9, 11, 12]) data[i] = 3;
  const mask = new Uint8Array(25);
  mask[6] = 1;
  const channel = {
    id: "0",
    title: "Height",
    width: 5,
    height: 5,
    xreal: 5,
    yreal: 5,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data,
    mask,
    metadata: { "Import / support": "unverified configuration" },
    log: [],
    warnings: [],
    selections: {},
  };
  const source = {
    channels: { 0: channel },
    sha256: "a".repeat(64),
    warnings: ["Source caveat"],
    unsupported: [],
  };
  const result = await analyze(
    {
      file: "synthetic.gwy",
      channel: "0",
      operations: [],
      selection: { roi: [0, 0, 4, 5] },
    },
    source,
    null,
    engine,
  );
  return { source, recipe: result.recipe };
}

test("strict replay segmentation is deterministic and preserves ROI, source masks and warnings", async () => {
  const { source, recipe } = await analyzed();
  const before = structuredClone(recipe);
  const code = await identity();
  const result = await segmentRecipe(
    { recipe, parameters: { threshold: 1 } },
    source,
    null,
    engine,
    code,
  );
  assert.deepEqual(
    result,
    await segmentRecipe(
      { recipe, parameters: { threshold: 1 } },
      source,
      null,
      engine,
      code,
    ),
  );
  assert.deepEqual(recipe, before);
  assert.deepEqual(result.input_recipe, recipe);
  assert.equal(result.input_recipe.created_at, recipe.created_at);
  assert.deepEqual(result.parameters.selection, recipe.selection);
  assert.equal(result.labels[6], 0, "source mask retained");
  assert.equal(result.labels[9], 0, "ROI retained");
  assert.equal(result.report.regions.length, 1);
  assert.equal(result.report.regions[0].pixel_count, 3);
  assert.equal(result.report.regions[0].area_unit, "(m)²");
  assert.ok(result.warnings.includes("Source caveat"));
  assert.ok(result.warnings.some((w) => /unverified configuration/.test(w)));
  const labels = Buffer.alloc(result.labels.length * 4);
  result.labels.forEach((n, i) => labels.writeUInt32LE(n, i * 4));
  assert.equal(result.labels_sha256, digest(labels));
  const document = Object.fromEntries(
    [
      "schema_version",
      "kind",
      "input_recipe",
      "code",
      "parameters",
      "report",
      "labels_sha256",
      "warnings",
    ].map((key) => [key, result[key]]),
  );
  assert.equal(result.report_sha256, digest(JSON.stringify(document)));
  assert.deepEqual(result.code, code);
  result.input_recipe.source.title = "changed";
  assert.equal(recipe.source.title, "Height");
});

test("wrong source, engine, changed saved output and selection override fail closed", async () => {
  const { source, recipe } = await analyzed();
  const code = await identity();
  const run = (
    r = recipe,
    s = source,
    e = engine,
    parameters = { threshold: 1 },
    c = code,
  ) => segmentRecipe({ recipe: r, parameters }, s, null, e, c);
  await assert.rejects(
    run(recipe, { ...source, sha256: "b".repeat(64) }),
    /Source SHA/,
  );
  await assert.rejects(run(recipe, source, "f".repeat(64)), /engine differs/);
  const changed = structuredClone(recipe);
  changed.output.sha256 = "b".repeat(64);
  await assert.rejects(run(changed), /Replay output differs/);
  await assert.rejects(
    run(recipe, source, engine, { threshold: 1, selection: {} }),
    /overrides/,
  );
  await assert.rejects(
    run(recipe, source, engine, { threshold: NaN }),
    /finite plain JSON/,
  );
  await assert.rejects(
    run(
      recipe,
      source,
      engine,
      { threshold: 1 },
      { ...code, sha256: "invalid" },
    ),
    /code identity/,
  );
});

test("excluded regions and unknown units remain explicit finite metadata", async () => {
  const { source } = await analyzed();
  source.channels[0].xy_unit = null;
  source.channels[0].z_unit = null;
  const { recipe } = await analyze(
    { file: "synthetic.gwy", channel: "0", operations: [] },
    source,
    null,
    engine,
  );
  const result = await segmentRecipe(
    { recipe, parameters: { threshold: 1, min_pixels: 5 } },
    source,
    null,
    engine,
    await identity(),
  );
  assert.equal(result.report.regions.length, 0);
  assert.ok(result.report.excluded_regions.length > 0);
  assert.equal(result.report.geometry.z_unit, null);
  assert.equal(result.report.excluded_regions[0].area_unit, null);
  assert.ok(result.labels.every((label) => label === 0));
  assert.doesNotThrow(() => JSON.stringify(result));
});

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

test("CLI writes fresh audited exports and refuses existing output without changing raw data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-segment-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "input.gwy"),
    recipePath = join(dir, "recipe.json"),
    out = join(dir, "output");
  const bytes = fixture();
  await writeFile(path, bytes);
  const source = await loadSource(path);
  const { recipe } = await analyze(
    { file: "input.gwy", channel: "0", operations: [] },
    source,
    null,
    await engineIdentity(source.format),
  );
  await writeFile(recipePath, JSON.stringify(recipe));
  const command = [
    new URL("../scripts/segment.mjs", import.meta.url).pathname,
    "--recipe",
    recipePath,
    "--input",
    path,
    "--out",
    out,
    "--threshold",
    "2e-9",
    "--min-pixels",
    "5",
  ];
  const { stdout } = await exec(process.execPath, command);
  const summary = JSON.parse(stdout);
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(summary.report_sha256, report.report_sha256);
  assert.deepEqual(report.input_recipe, recipe);
  assert.deepEqual(
    JSON.parse(await readFile(join(out, "input-recipe.json"), "utf8")),
    recipe,
  );
  assert.deepEqual(report.code, await identity());
  const tsv = await readFile(join(out, "regions.tsv"), "utf8");
  assert.match(tsv, /excluded_reasons/);
  assert.match(tsv, /excluded/);
  assert.match(tsv, /xy_unit/);
  assert.match(tsv, /\(m\)²/);
  const before = await readFile(join(out, "report.json"));
  await assert.rejects(exec(process.execPath, command), /EEXIST/);
  assert.deepEqual(await readFile(join(out, "report.json")), before);
  assert.deepEqual(await readFile(path), bytes);
});

test("source title and strict request JSON cannot be silently changed", async () => {
  const { source, recipe } = await analyzed();
  const code = await identity();
  const run = (request) => segmentRecipe(request, source, null, engine, code);
  const changed = structuredClone(recipe);
  changed.source.title = "Different channel";
  await assert.rejects(
    run({ recipe: changed, parameters: { threshold: 1 } }),
    /source channel or title/,
  );
  await assert.rejects(
    run({ recipe, parameters: { threshold: 1 }, unused: true }),
    /only recipe and parameters/,
  );
  const symbol = { recipe, parameters: { threshold: 1 } };
  symbol[Symbol("hidden")] = 1;
  await assert.rejects(run(symbol), /symbol keys/);
  const getter = {
    recipe,
    get parameters() {
      throw new Error("must not run");
    },
  };
  await assert.rejects(run(getter), /accessors/);
  const inherited = Object.assign(Object.create({ extra: 1 }), {
    recipe,
    parameters: { threshold: 1 },
  });
  await assert.rejects(run(inherited), /finite plain JSON/);
});
