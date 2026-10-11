import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyze } from "../web/service.js";
import {
  registrationRecipe,
  registrationBundle,
} from "../web/registration-service.js";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
const exec = promisify(execFile),
  digest = (v) => createHash("sha256").update(v).digest("hex"),
  engine = "e".repeat(64);
async function identity() {
  const names = ["registration.js", "registration-service.js", "engine.js"],
    parts = await Promise.all(
      names.map((name) =>
        readFile(new URL("../web/" + name, import.meta.url), "utf8"),
      ),
    );
  return {
    sha256: digest(parts.join("\n")),
    files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
  };
}
function source(hash, width = 4, height = 3) {
  return {
    sha256: hash.repeat(64),
    channels: {
      0: {
        id: "0",
        title: "Height",
        width,
        height,
        xreal: width,
        yreal: height,
        xoff: 0,
        yoff: 0,
        xy_unit: "m",
        z_unit: "m",
        data: Float64Array.from({ length: width * height }, (_, i) => i),
        mask: null,
        metadata: { "Import / support": "unverified configuration" },
        warnings: [],
        log: [],
      },
    },
    warnings: ["Source warning"],
    unsupported: [],
  };
}
async function inputs(references = false, width = 4, height = 3) {
  const fixed = source("a", width, height),
    moving = source("b", width, height),
    fixedReference = references ? source("c", width, height) : null,
    movingReference = references ? source("d", width, height) : null;
  const recipe = async (s, name, r) =>
    (
      await analyze(
        {
          file: name,
          channel: "0",
          operations: [],
          reference: r ? { file: name + ".ref", channel: "0" } : null,
        },
        s,
        r,
        engine,
      )
    ).recipe;
  return {
    fixed,
    moving,
    fixedReference,
    movingReference,
    request: {
      fixed_recipe: await recipe(fixed, "fixed.gwy", fixedReference),
      moving_recipe: await recipe(moving, "moving.gwy", movingReference),
      parameters: { mode: "manual", tx: 1, ty: 0, interpolation: "nearest" },
    },
    engines: { fixed: engine, moving: engine },
    code: await identity(),
  };
}
function run(i) {
  return registrationRecipe(
    i.request,
    i.fixed,
    i.moving,
    i.fixedReference,
    i.movingReference,
    i.engines,
    i.code,
  );
}
function entries(bytes) {
  const result = {};
  for (let i = 0; i + 512 <= bytes.length; ) {
    const h = Buffer.from(bytes.subarray(i, i + 512)),
      name = h.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
      h.subarray(124, 136).toString().replace(/\0/g, ""),
      8,
    );
    result[name] = Buffer.from(bytes.subarray(i + 512, i + 512 + size));
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

test("dual strict replay is deterministic with canonical missing bytes and independently verified hashes", async () => {
  const i = await inputs(),
    before = structuredClone(i.request),
    a = await run(i),
    b = await run(i);
  assert.deepEqual(a, b);
  assert.deepEqual(i.request, before);
  assert.deepEqual(a.report.input_recipes, {
    fixed: before.fixed_recipe,
    moving: before.moving_recipe,
  });
  assert.equal(a.report.transform.tx, 1);
  assert.equal(a.report.metrics.valid_count, 9);
  assert.ok(
    a.report.warnings.some(
      (w) => w.startsWith("Fixed:") && w.includes("Source warning"),
    ),
  );
  assert.ok(
    a.report.warnings.some((w) => w.includes("Moving imported support")),
  );
  for (const key of ["aligned", "difference", "valid"])
    assert.equal(a.report.arrays[key].sha256, digest(a.rasters[key]));
  assert.equal(
    Buffer.from(a.rasters.aligned.subarray(0, 8)).toString("hex"),
    "000000000000f87f",
  );
  assert.equal(
    new DataView(a.rasters.difference.buffer).getFloat64(8, true),
    1,
  );
  assert.equal(a.rasters.valid[0], 0);
  assert.equal(a.rasters.valid[1], 1);
  assert.equal(a.report.arrays.aligned.x_axis.start, 0.5);
  assert.equal(a.report.arrays.aligned.x_axis.step, 1);
  const { report_sha256, ...unsigned } = a.report;
  assert.equal(report_sha256, digest(JSON.stringify(unsigned)));
  const tar = registrationBundle(a);
  assert.deepEqual(tar, registrationBundle(b));
  const files = entries(tar);
  assert.deepEqual(Object.keys(files), [
    "report.json",
    "fixed-recipe.json",
    "moving-recipe.json",
    "README.txt",
    "aligned.f64",
    "difference.f64",
    "valid.u8",
  ]);
  assert.deepEqual(files["aligned.f64"], Buffer.from(a.rasters.aligned));
  assert.deepEqual(JSON.parse(files["fixed-recipe.json"]), before.fixed_recipe);
});
test("overviews average only common-valid samples using explicit unequal bins", async () => {
  const i = await inputs(false, 513, 2);
  i.request.parameters.tx = 2;
  const { report } = await run(i),
    o = report.overviews.aligned;
  assert.equal(o.width, 256);
  assert.equal(o.data[0], null);
  assert.equal(o.valid_counts[0], 0);
  assert.equal(o.aggregation, "mean of common-valid pixels in recorded bins");
  for (let row = 0; row < o.height; row++)
    for (let col = 0; col < o.width; col++) {
      const [xs, xe] = o.x_bins[col],
        [ys, ye] = o.y_bins[row];
      let count = 0,
        sum = 0;
      for (let y = ys; y < ye; y++)
        for (let x = xs; x < xe; x++)
          if (x >= 2) {
            count++;
            sum += y * 513 + x - 2;
          }
      const index = row * o.width + col;
      assert.equal(o.valid_counts[index], count);
      assert.equal(o.data[index], count ? sum / count : null);
      assert.equal(o.x[col], (xs + xe) / 2);
    }
});
test("wrong source title geometry engine output and selection overrides reject on either input", async () => {
  const base = await inputs();
  const changes = [
    (i) => (i.fixed.sha256 = "f".repeat(64)),
    (i) => (i.moving.sha256 = "f".repeat(64)),
    (i) => (i.request.fixed_recipe.source.title = "edited"),
    (i) => (i.request.moving_recipe.source.title = "edited"),
    (i) => (i.request.fixed_recipe.source.geometry.xreal = 9),
    (i) => (i.request.moving_recipe.output.sha256 = "f".repeat(64)),
    (i) => (i.engines.fixed = "f".repeat(64)),
    (i) => (i.engines.moving = "f".repeat(64)),
    (i) => (i.request.parameters.fixed_selection = {}),
    (i) => (i.request.parameters.moving_selection = {}),
    (i) => (i.request.extra = true),
    (i) => (i.request.parameters.tx = NaN),
  ];
  for (const change of changes) {
    const i = structuredClone(base);
    change(i);
    await assert.rejects(run(i));
  }
});
test("both recorded references replay and missing or wrong references fail", async () => {
  const i = await inputs(true);
  assert.equal((await run(i)).report.metrics.valid_count, 9);
  for (const key of ["fixedReference", "movingReference"]) {
    const missing = structuredClone(i);
    missing[key] = null;
    await assert.rejects(run(missing));
    const wrong = structuredClone(i);
    wrong[key].sha256 = "f".repeat(64);
    await assert.rejects(run(wrong));
  }
});
test("request captured before awaits cannot be edited during replay", async () => {
  const i = await inputs(),
    promise = run(i);
  i.request.parameters.tx = 123;
  i.request.fixed_recipe.source.title = "edited later";
  const { report } = await promise;
  assert.equal(report.transform.tx, 1);
  assert.equal(report.input_recipes.fixed.source.title, "Height");
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
test("CLI exports both recipes and raster archive into a fresh directory only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-registration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "source.gwy"),
    recipePath = join(dir, "recipe.json"),
    out = join(dir, "output"),
    bytes = fixture();
  await writeFile(input, bytes);
  const source = await loadSource(input);
  const { recipe } = await analyze(
    { file: "source.gwy", channel: "0", operations: [] },
    source,
    null,
    await engineIdentity(source.format),
  );
  await writeFile(recipePath, JSON.stringify(recipe));
  const args = [
    new URL("../scripts/register.mjs", import.meta.url).pathname,
    "--fixed-recipe",
    recipePath,
    "--moving-recipe",
    recipePath,
    "--fixed",
    input,
    "--moving",
    input,
    "--out",
    out,
    "--mode",
    "manual",
    "--tx",
    "0",
    "--ty",
    "0",
    "--interpolation",
    "nearest",
  ];
  const { stdout } = await exec(process.execPath, args),
    summary = JSON.parse(stdout),
    report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(summary.report_sha256, report.report_sha256);
  assert.equal(report.metrics.rmse, 0);
  assert.deepEqual(report.code, await identity());
  const archive = entries(await readFile(join(out, "registration.tar")));
  assert.equal(archive["valid.u8"].length, 6);
  assert.deepEqual(
    archive["aligned.f64"],
    await readFile(join(out, "aligned.f64")),
  );
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
  assert.deepEqual(await readFile(input), bytes);
  await assert.rejects(
    exec(process.execPath, [...args, "--radius-x", "1"]),
    /Do not mix/,
  );
});

test("each captured recipe selection and source mask restricts common overlap", async () => {
  const i = await inputs();
  i.fixed.channels[0].mask = new Uint8Array(12);
  i.fixed.channels[0].mask[1] = 1;
  i.moving.channels[0].mask = new Uint8Array(12);
  i.moving.channels[0].mask[4] = 1;
  i.request.fixed_recipe = (
    await analyze(
      {
        file: "fixed.gwy",
        channel: "0",
        operations: [],
        selection: { roi: [0, 0, 2, 3] },
      },
      i.fixed,
      null,
      engine,
    )
  ).recipe;
  i.request.moving_recipe = (
    await analyze(
      {
        file: "moving.gwy",
        channel: "0",
        operations: [],
        selection: { roi: [0, 0, 4, 3] },
      },
      i.moving,
      null,
      engine,
    )
  ).recipe;
  i.request.parameters.tx = 0;
  const { report, rasters } = await run(i);
  assert.equal(report.metrics.valid_count, 4);
  assert.deepEqual(
    report.parameters.fixed_selection,
    i.request.fixed_recipe.selection,
  );
  assert.deepEqual(
    report.parameters.moving_selection,
    i.request.moving_recipe.selection,
  );
  for (const index of [1, 2, 3, 4]) assert.equal(rasters.valid[index], 0);
});

test("automatic proposal retains normalized parameters candidates ties and stable hashes", async () => {
  const i = await inputs();
  i.request.parameters = {
    mode: "automatic",
    radius_x: 1,
    radius_y: 1,
    min_overlap_fraction: 0.5,
  };
  const a = await run(i),
    b = await run(i);
  assert.deepEqual(a, b);
  assert.equal(a.report.parameters.interpolation, "integer");
  assert.equal(a.report.search.candidates.length, 9);
  assert.ok(a.report.search.tied_candidates.length > 1);
  assert.deepEqual(a.report.transform.pixel_shift, [0, 0]);
  assert.equal(a.report.metrics.overlap_fraction, 1);
});
