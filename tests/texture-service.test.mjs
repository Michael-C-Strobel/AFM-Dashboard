import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { textureRecipe, textureBundle } from "../web/texture-service.js";
import { textureSurface } from "../web/texture.js";
import { analyze } from "../web/service.js";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
const exec = promisify(execFile),
  engine = "e".repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function identity() {
  const names = ["fft.js", "texture.js", "texture-service.js", "engine.js"];
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
async function analyzed(
  width = 5,
  height = 4,
  selection = null,
  constant = false,
) {
  const channel = {
    id: "0",
    title: "Height",
    width,
    height,
    xreal: width * 2,
    yreal: height * 3,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data: Float64Array.from({ length: width * height }, (_, i) =>
      constant ? 0 : Math.sin(i) + i / 10,
    ),
    mask: null,
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
  const { recipe } = await analyze(
    { file: "synthetic.gwy", channel: "0", operations: [], selection },
    source,
    null,
    engine,
  );
  return { source, recipe };
}
const run = async ({ source, recipe }, parameters = {}) =>
  textureRecipe({ recipe, parameters }, source, null, engine, await identity());
function parseTar(bytes) {
  const entries = {};
  for (let offset = 0; offset < bytes.length - 1024; ) {
    const header = bytes.subarray(offset, offset + 512),
      name = Buffer.from(header.subarray(0, 100)).toString().split("\0")[0];
    if (!name) break;
    assert.equal(Buffer.from(header.subarray(257, 262)).toString(), "ustar");
    const size = parseInt(
      Buffer.from(header.subarray(124, 136)).toString().replace(/\0/g, ""),
      8,
    );
    entries[name] = bytes.slice(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
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

test("strict replay produces deterministic compact evidence and exact little-endian arrays", async () => {
  const input = await analyzed(5, 4, { roi: [2, 0, 10, 9] });
  const before = structuredClone(input),
    result = await run(input, { detrend: "mean", window: "hann" });
  assert.deepEqual(
    result,
    await run(input, { detrend: "mean", window: "hann" }),
  );
  assert.deepEqual(input, before);
  const { report, rasters } = result;
  assert.deepEqual(report.input_recipe, input.recipe);
  assert.deepEqual(report.parameters.selection, input.recipe.selection);
  assert.deepEqual(report.source_bounds, [1, 0, 5, 3]);
  assert.ok(report.warnings.includes("Source caveat"));
  assert.ok(
    report.warnings.some((w) => w.includes("unverified configuration")),
  );
  const core = textureSurface(input.source.channels[0], {
    detrend: "mean",
    window: "hann",
    selection: input.recipe.selection,
  });
  for (const [key, values] of [
    ["psd", core.psd.data],
    ["acf", core.acf.data],
    ["acf_normalized", core.acf.normalized],
  ]) {
    const m = report.arrays[key],
      bytes = rasters[key];
    assert.equal(bytes.length, m.width * m.height * 8);
    assert.equal(digest(bytes), m.sha256);
    const decoded = Array.from({ length: values.length }, (_, i) =>
      Buffer.from(bytes).readDoubleLE(i * 8),
    );
    assert.deepEqual(decoded, Array.from(values));
    assert.equal(m.x_axis.count, m.width);
    assert.equal(m.y_axis.count, m.height);
  }
  assert.equal(report.arrays.psd.x_axis.unit, "cycles/(m)");
  assert.equal(report.arrays.acf.y_axis.step, 3);
  const { report_sha256, ...body } = report;
  assert.equal(report_sha256, digest(JSON.stringify(body)));
  assert.equal(Object.hasOwn(report.psd, "data"), false);
  assert.equal(Object.hasOwn(report.acf, "data"), false);
  const entries = parseTar(textureBundle(result));
  assert.deepEqual(Object.keys(entries), [
    "report.json",
    "input-recipe.json",
    "README.txt",
    "psd.f64",
    "acf.f64",
    "acf_normalized.f64",
  ]);
  for (const [key, m] of Object.entries(report.arrays))
    assert.deepEqual(entries[m.file], rasters[key]);
  assert.deepEqual(
    JSON.parse(Buffer.from(entries["report.json"]).toString()),
    report,
  );
  assert.match(Buffer.from(entries["README.txt"]).toString(), /little-endian/);
});
test("wrong source, title, engine, saved output and selection overrides are rejected", async () => {
  const { source, recipe } = await analyzed(),
    code = await identity();
  const call = (r = recipe, s = source, e = engine, p = {}, c = code) =>
    textureRecipe({ recipe: r, parameters: p }, s, null, e, c);
  await assert.rejects(
    call(recipe, { ...source, sha256: "b".repeat(64) }),
    /Source SHA/,
  );
  await assert.rejects(call(recipe, source, "f".repeat(64)), /engine differs/);
  const wrong = structuredClone(recipe);
  wrong.source.title = "different";
  await assert.rejects(call(wrong), /channel or title/);
  const changed = structuredClone(recipe);
  changed.output.sha256 = "b".repeat(64);
  await assert.rejects(call(changed), /Replay output differs/);
  await assert.rejects(
    call(recipe, source, engine, { selection: {} }),
    /overrides/,
  );
  await assert.rejects(
    call(
      recipe,
      source,
      engine,
      {},
      { ...code, files: [...code.files].reverse() },
    ),
    /code identity/,
  );
  const moved = structuredClone(recipe);
  moved.selection.roi = [0, 0, 2, 2];
  await assert.rejects(call(moved));
});
test("plain finite request validation rejects hidden, inherited and accessor state without invoking it", async () => {
  const { source, recipe } = await analyzed(),
    code = await identity();
  const call = (r) => textureRecipe(r, source, null, engine, code);
  await assert.rejects(
    call({ recipe, parameters: {}, extra: true }),
    /only recipe and parameters/,
  );
  await assert.rejects(
    call({ recipe, parameters: { detrend: NaN } }),
    /finite plain JSON/,
  );
  await assert.rejects(
    call({
      recipe,
      get parameters() {
        throw Error("getter invoked");
      },
    }),
    /accessors/,
  );
  await assert.rejects(
    call(Object.assign(Object.create({}), { recipe, parameters: {} })),
    /finite plain JSON/,
  );
  const hidden = { recipe, parameters: {} };
  hidden[Symbol("hidden")] = 1;
  await assert.rejects(call(hidden), /symbol keys/);
});
test("input request and identity are captured before replay awaits", async () => {
  const { source, recipe } = await analyzed(),
    code = await identity();
  const original = structuredClone(recipe),
    request = { recipe, parameters: { detrend: "none", window: "boxcar" } };
  const pending = textureRecipe(request, source, null, engine, code);
  request.parameters.detrend = "invalid";
  recipe.source.title = "changed";
  code.files[0].name = "changed";
  const result = await pending;
  assert.deepEqual(result.report.input_recipe, original);
  assert.equal(result.report.parameters.detrend, "none");
  assert.equal(result.report.code.files[0].name, "fft.js");
});
test("overview block means and central cuts match full-resolution arrays", async () => {
  const input = await analyzed(129, 130),
    result = await run(input, { detrend: "none", window: "boxcar" });
  for (const key of ["psd", "acf"]) {
    const { report, rasters } = result,
      m = report.arrays[key],
      o = report[key].overview;
    assert.ok(o.width <= 256 && o.height <= 256);
    assert.ok(report[key].cuts.x.values.length <= 2048);
    const buffer = Buffer.from(rasters[key]);
    const values = Float64Array.from({ length: m.width * m.height }, (_, i) =>
      buffer.readDoubleLE(i * 8),
    );
    for (const [bx, by] of [
      [0, 0],
      [o.width - 1, o.height - 1],
      [100, 100],
    ]) {
      const [xs, xe] = o.x_bins[bx],
        [ys, ye] = o.y_bins[by];
      let sum = 0;
      for (let y = ys; y < ye; y++)
        for (let x = xs; x < xe; x++)
          sum += values[y * m.width + x] / ((xe - xs) * (ye - ys));
      assert.equal(o.data[by * o.width + bx], sum);
    }
    const c = report[key].cuts.x;
    for (let i = 0; i < c.bins.length; i++) {
      const [s, e] = c.bins[i];
      let expected = 0;
      for (let x = s; x < e; x++)
        expected += values[Math.floor(m.height / 2) * m.width + x] / (e - s);
      assert.equal(c.values[i], expected);
    }
  }
  assert.ok(
    JSON.stringify(result.report).length < 5_000_000,
    "bounded reduced report",
  );
});
test("zero-energy normalized ACF is null in metadata and absent from archive", async () => {
  const result = await run(await analyzed(4, 4, null, true));
  assert.equal(result.report.acf.normalized_overview, null);
  assert.equal(result.report.arrays.acf_normalized, null);
  assert.equal(result.rasters.acf_normalized, null);
  assert.equal(
    Object.hasOwn(parseTar(textureBundle(result)), "acf_normalized.f64"),
    false,
  );
});
test("CLI writes fresh evidence and refuses existing output without altering source", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-texture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.gwy"),
    rp = join(dir, "recipe.json"),
    out = join(dir, "out"),
    bytes = fixture();
  await writeFile(input, bytes);
  const source = await loadSource(input);
  const { recipe } = await analyze(
    { file: "input.gwy", channel: "0", operations: [] },
    source,
    null,
    await engineIdentity(source.format),
  );
  await writeFile(rp, JSON.stringify(recipe));
  const args = [
    new URL("../scripts/texture.mjs", import.meta.url).pathname,
    "--recipe",
    rp,
    "--input",
    input,
    "--out",
    out,
    "--detrend",
    "none",
    "--window",
    "boxcar",
  ];
  const { stdout } = await exec(process.execPath, args),
    summary = JSON.parse(stdout),
    report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(summary.report_sha256, report.report_sha256);
  assert.deepEqual(report.code, await identity());
  assert.deepEqual(report.input_recipe, recipe);
  const entries = parseTar(await readFile(join(out, "texture.tar")));
  for (const name of Object.keys(entries))
    assert.deepEqual(
      Buffer.from(entries[name]),
      await readFile(join(out, name)),
    );
  const before = await readFile(join(out, "report.json"));
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
  assert.deepEqual(await readFile(join(out, "report.json")), before);
  assert.deepEqual(await readFile(input), bytes);
});

test("long directional cuts reduce recorded half-open bins without dropping endpoints", async () => {
  const result = await run(await analyzed(1025, 2), {
    detrend: "none",
    window: "boxcar",
  });
  for (const key of ["psd", "acf"]) {
    const m = result.report.arrays[key],
      c = result.report[key].cuts.x;
    assert.equal(c.values.length, 2048);
    assert.equal(c.bins[0][0], 0);
    assert.equal(c.bins.at(-1)[1], m.width);
    const bytes = Buffer.from(result.rasters[key]);
    for (let i = 0; i < c.bins.length; i++) {
      const [start, end] = c.bins[i];
      assert.equal(start, Math.floor((i * m.width) / 2048));
      assert.equal(end, Math.floor(((i + 1) * m.width) / 2048));
      let value = 0;
      for (let x = start; x < end; x++)
        value +=
          bytes.readDoubleLE(8 * (Math.floor(m.height / 2) * m.width + x)) /
          (end - start);
      assert.equal(c.values[i], value);
    }
  }
});

test("masked pixels survive replay as invalid samples and prevent texture estimation", async () => {
  const { source } = await analyzed();
  source.channels[0].mask = new Uint8Array(20);
  source.channels[0].mask[7] = 1;
  const { recipe } = await analyze(
    { file: "synthetic.gwy", channel: "0", operations: [] },
    source,
    null,
    engine,
  );
  await assert.rejects(run({ source, recipe }), /complete|mask|nonfinite/i);
});

test("domain metadata records full, ROI, crop and trimmed processed coordinates in JSON and TAR", async () => {
  const base = await analyzed(5, 4);
  const cases = [
    {
      name: "full",
      source: base.source,
      operations: [],
      selection: {},
      kind: "full_processed_image",
      pixels: [0, 0, 5, 4],
      physical: [0, 0, 10, 12],
    },
    {
      name: "roi",
      source: base.source,
      operations: [],
      selection: { roi: [2, 0, 10, 9] },
      kind: "roi",
      pixels: [1, 0, 5, 3],
      physical: [2, 0, 10, 9],
    },
    {
      name: "crop",
      source: base.source,
      operations: [{ name: "crop", params: { bounds: [2, 3, 10, 12] } }],
      selection: {},
      kind: "cropped_image",
      pixels: [0, 0, 4, 3],
      physical: [2, 3, 10, 12],
    },
    {
      name: "crop with roi",
      source: base.source,
      operations: [{ name: "crop", params: { bounds: [2, 3, 10, 12] } }],
      selection: { roi: [4, 3, 10, 9] },
      kind: "roi",
      pixels: [1, 0, 4, 2],
      physical: [4, 3, 10, 9],
    },
  ];
  const trimmed = structuredClone(base.source);
  for (let x = 0; x < 5; x++) trimmed.channels[0].data[x] = NaN;
  for (let y = 0; y < 4; y++) trimmed.channels[0].data[y * 5] = NaN;
  cases.push({
    name: "invalid outer edges",
    source: trimmed,
    operations: [],
    selection: {},
    kind: "full_processed_image",
    pixels: [1, 1, 5, 4],
    physical: [2, 3, 10, 12],
  });
  cases.push({
    name: "excluded edge",
    source: base.source,
    operations: [],
    selection: {
      exclude_polygons: [
        [
          [0, 0],
          [2, 0],
          [2, 12],
          [0, 12],
        ],
      ],
    },
    kind: "full_processed_image",
    pixels: [1, 0, 5, 4],
    physical: [2, 0, 10, 12],
  });
  for (const item of cases) {
    const { recipe } = await analyze(
      {
        file: "synthetic.gwy",
        channel: "0",
        operations: item.operations,
        selection: item.selection,
      },
      item.source,
      null,
      engine,
    );
    const result = await run({ source: item.source, recipe });
    const { report } = result;
    const expected = {
      kind: item.kind,
      processed_geometry: structuredClone(recipe.output.geometry),
      requested_roi: recipe.selection.roi,
      exclude_polygon_count: recipe.selection.exclude_polygons.length,
      effective_pixel_bounds: item.pixels,
      effective_physical_bounds: item.physical,
      effective_geometry: structuredClone(report.geometry),
    };
    assert.deepEqual(report.domain, expected, item.name);
    assert.deepEqual(report.domain.effective_geometry.shape, [
      item.pixels[3] - item.pixels[1],
      item.pixels[2] - item.pixels[0],
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(report)).domain, expected);
    const entries = parseTar(textureBundle(result));
    assert.deepEqual(
      JSON.parse(Buffer.from(entries["report.json"]).toString()).domain,
      expected,
    );
    assert.deepEqual(
      JSON.parse(Buffer.from(entries["input-recipe.json"]).toString()),
      recipe,
    );
    const readme = Buffer.from(entries["README.txt"]).toString();
    assert.match(readme, /half-open.*processed output/);
    assert.match(readme, /retaining all crop operations/);
    assert.match(readme, /Invalid outer rows or columns may be trimmed/);
    assert.match(readme, /holes are rejected/);
    const { report_sha256, ...body } = report;
    assert.equal(report_sha256, digest(JSON.stringify(body)));
    assert.notStrictEqual(
      report.domain.processed_geometry,
      report.input_recipe.output.geometry,
    );
    assert.notStrictEqual(report.domain.effective_geometry, report.geometry);
    assert.notStrictEqual(
      report.domain.effective_pixel_bounds,
      report.source_bounds,
    );
    if (recipe.selection.roi)
      assert.notStrictEqual(
        report.domain.requested_roi,
        report.input_recipe.selection.roi,
      );
  }
});
