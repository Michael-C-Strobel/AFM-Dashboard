import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { compareRuns } from "../web/comparison.js";
import { comparisonTSV, main, tsvCell } from "../scripts/compare.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
function record(n = 1) {
  const geometry = {
    shape: [2, 2],
    xreal: 2,
    yreal: 2,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
  };
  return {
    run: `run-${n}`,
    recipe_sha256: hash(100 + n),
    analysis_sha256: hash(200 + n),
    recipe: {
      schema_version: 1,
      engine: { name: "afm-dashboard-js", version: "0.1.0", sha256: hash(999) },
      source: {
        file: `source-${n}.gwy`,
        sha256: hash(n),
        channel: "0",
        title: "Height",
        geometry: structuredClone(geometry),
      },
      output: {
        sha256: hash(10 + n),
        measurement_sha256: hash(20 + n),
        mask_sha256: null,
        geometry: structuredClone(geometry),
      },
      operations: [],
      selection: { roi: null, exclude_polygons: [] },
      profile: null,
      plateaus: null,
    },
    analysis: {
      channel: { id: "0", title: "Height", ...geometry },
      history: [],
      statistics: {
        sa: 1,
        sq: 1,
        min: 0,
        max: 2,
        mean: 1,
        valid_count: 4,
        excluded_count: 0,
        area: 4,
        z_unit: "m",
        xy_unit: "m",
        area_unit: "(m)²",
        reference: "selected arithmetic mean",
      },
    },
  };
}
const setUnits = (r, z, xy = "m") => {
  for (const g of [
    r.recipe.source.geometry,
    r.recipe.output.geometry,
    r.analysis.channel,
  ]) {
    g.z_unit = z;
    g.xy_unit = xy;
  }
  Object.assign(r.analysis.statistics, {
    z_unit: z,
    xy_unit: xy,
    area_unit: `(${xy})²`,
  });
};

test("deterministic matching groups retain per-acquisition metrics and no inferred samples", () => {
  const input = [record(1), record(2)],
    before = structuredClone(input),
    r = compareRuns(input);
  assert.deepEqual(r, compareRuns(input));
  assert.deepEqual(input, before);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].acquisition_count, 2);
  assert.equal(r.groups[0].unique_explicit_independent_sample_count, null);
  assert.equal(r.groups[0].unassigned_acquisition_count, 2);
  assert.deepEqual(
    r.rows.map((x) => [x.sa, x.sq, x.mean, x.area]),
    [
      [1, 1, 1, 4],
      [1, 1, 1, 4],
    ],
  );
  assert.equal("pooled_mean" in r.groups[0], false);
});
test("explicit sample identity counts unique biological samples, not files", () => {
  const input = [record(1), record(2), record(3)];
  const r = compareRuns(input, {
    [hash(1)]: "sample-A",
    [hash(2)]: "sample-A",
    [hash(3)]: "sample-B",
  });
  assert.equal(r.acquisition_count, 3);
  assert.equal(r.unique_explicit_independent_sample_count, 2);
  const partial = compareRuns(input, { [hash(1)]: "sample-A" });
  assert.equal(partial.unique_explicit_independent_sample_count, null);
  assert.equal(partial.unassigned_acquisition_count, 2);
  assert.throws(() => compareRuns(input, { [hash(1)]: "" }), /Sample map/);
});
test("identical full measurement duplicates excluded even with different run names", () => {
  const a = record(),
    b = structuredClone(a);
  b.run = "copied";
  const r = compareRuns([a, b]);
  assert.equal(r.included_count, 1);
  assert.equal(r.excluded_count, 1);
  assert.match(r.rows[1].reason, /Duplicate of input 0/);
  assert.equal(r.acquisition_count, 1);
});
test("exact units, engine, ROI, geometry, operations, versions and profile separate groups", () => {
  const input = Array.from({ length: 9 }, (_, i) => record(i + 1));
  setUnits(input[1], "nm");
  input[2].recipe.engine.sha256 = hash(888);
  input[3].recipe.selection.roi = [0, 0, 1, 1];
  input[4].recipe.source.geometry.xoff = 1;
  for (const i of [5, 6]) {
    input[i].recipe.operations = [{ name: "zero_min", params: {} }];
    input[i].analysis.history = [
      { name: "zero_min", params: {}, version: i - 4, details: {} },
    ];
  }
  input[7].recipe.profile = [
    [0, 0],
    [1, 1],
  ];
  input[8].recipe.plateaus = [
    [0, 0, 0.5, 0.5],
    [1, 1, 2, 2],
  ];
  const r = compareRuns(input);
  assert.equal(r.excluded_count, 0);
  assert.equal(r.groups.length, 9);
  const reordered = structuredClone(input[0]);
  reordered.recipe.selection = { exclude_polygons: [], roi: null };
  reordered.recipe.source.sha256 = hash(90);
  assert.equal(compareRuns([input[0], reordered]).groups.length, 1);
});
test("missing, unknown, arbitrary units and mismatched metric units are excluded", () => {
  const input = ["unknown", "Arb", "banana", null, ""].map((unit, i) => {
    const r = record(i + 1);
    setUnits(r, unit);
    return r;
  });
  const mismatch = record(9);
  mismatch.analysis.statistics.z_unit = "nm";
  input.push(mismatch);
  const r = compareRuns(input);
  assert.equal(r.excluded_count, 6);
  assert.ok(r.rows.every((x) => /unit/i.test(x.reason)));
});
test("invalid records remain represented without aborting valid acquisitions", () => {
  const bad = record(3);
  bad.analysis.statistics.sq = NaN;
  const missing = record(4);
  delete missing.recipe.output.measurement_sha256;
  const area = record(5);
  area.analysis.statistics.area = 999;
  const ops = record(6);
  ops.analysis.history = [{ name: "zero_min", params: {}, version: 1 }];
  const report = compareRuns([
    null,
    {},
    { run: "missing", error: "recipe.json: ENOENT" },
    bad,
    missing,
    area,
    ops,
    record(10),
  ]);
  assert.equal(report.rows.length, 8);
  assert.equal(report.included_count, 1);
  assert.ok(report.rows.slice(0, 7).every((r) => r.reason));
});
test("TSV preserves text and neutralizes formulas including whitespace-prefixed formulas", () => {
  assert.equal(tsvCell("=SUM(1,2)"), "'=SUM(1,2)");
  assert.equal(tsvCell("  +1"), "'  +1");
  assert.equal(tsvCell("@A1"), "'@A1");
  assert.equal(tsvCell("-1"), "'-1");
  assert.equal(tsvCell(-1), "-1");
  assert.equal(tsvCell('a\tb\n"c"'), '"a\tb\n""c"""');
  assert.equal(tsvCell("\t=1"), '"\'\t=1"');
  const a = record();
  a.recipe.source.file = '=HYPERLINK("bad")';
  a.recipe.source.title = "Height\twith\nnotes";
  a.analysis.channel.title = a.recipe.source.title;
  const text = comparisonTSV(compareRuns([a]));
  assert.match(text, /'=HYPERLINK/);
  assert.match(text, /"Height\twith\nnotes"/);
});
test("CLI includes missing/malformed directories, exact artifact hashes and nonzero exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afm-comparison-test-"));
  try {
    const good = join(dir, "good"),
      broken = join(dir, "broken"),
      out = join(dir, "out");
    await mkdir(good);
    await mkdir(broken);
    const r = record();
    const recipe = JSON.stringify(r.recipe) + "\n";
    await writeFile(join(good, "recipe.json"), recipe);
    await writeFile(join(good, "analysis.json"), JSON.stringify(r.analysis));
    await writeFile(join(broken, "recipe.json"), "{broken");
    assert.equal(
      await main([good, broken, join(dir, "missing"), "--out", out]),
      1,
    );
    const result = JSON.parse(
      await readFile(join(out, "comparison.json"), "utf8"),
    );
    assert.equal(result.rows.length, 3);
    assert.equal(result.included_count, 1);
    assert.equal(
      result.rows[0].recipe_sha256,
      createHash("sha256").update(recipe).digest("hex"),
    );
    assert.match(result.rows[1].reason, /SyntaxError/);
    assert.match(result.rows[2].reason, /ENOENT/);
    assert.match(
      await readFile(join(out, "comparison.tsv"), "utf8"),
      /metadata|source_file/,
    );
    const map = join(dir, "samples.json");
    await writeFile(map, JSON.stringify({ [hash(1)]: "independent-1" }));
    assert.equal(await main([good, "--out", out, "--samples", map]), 0);
    assert.equal(
      JSON.parse(await readFile(join(out, "comparison.json"), "utf8"))
        .unique_explicit_independent_sample_count,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same source across regions/profiles remains included but counts once as acquisition", () => {
  const input = [record(), record(), record()];
  input[1].recipe.selection.roi = [0, 0, 1, 1];
  input[2].recipe.profile = [
    [0, 0],
    [1, 1],
  ];
  const r = compareRuns(input);
  assert.equal(r.included_count, 3);
  assert.equal(r.groups.length, 3);
  assert.equal(r.acquisition_count, 1);
  assert.equal(r.unassigned_acquisition_count, 1);
  assert.equal(r.unique_explicit_independent_sample_count, null);
});
test("different mask or measurement hashes are not duplicate outputs", () => {
  const input = [record(), record(), record()];
  input[1].recipe.output.mask_sha256 = hash(7);
  input[2].recipe.output.measurement_sha256 = hash(8);
  const r = compareRuns(input);
  assert.equal(r.included_count, 3);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].acquisition_count, 1);
});
test("support caveats and all artifact warnings remain visible in every output row", () => {
  const a = record();
  a.analysis.channel.metadata = {
    "Import / support": "unverified configuration",
  };
  a.analysis.warnings = ["warning A"];
  a.analysis.quality = { warnings: ["warning B"] };
  const r = compareRuns([a]);
  assert.equal(r.rows[0].import_support, "unverified configuration");
  assert.deepEqual(r.rows[0].warnings, ["warning A"]);
  assert.deepEqual(r.rows[0].quality_warnings, ["warning B"]);
  assert.match(comparisonTSV(r), /unverified configuration/);
});
test("constant image statistics tolerate a tiny floating-point mean overshoot", () => {
  const r = record();
  Object.assign(r.analysis.statistics, {
    min: 1,
    max: 1,
    mean: 1 + Number.EPSILON,
    sa: Number.EPSILON,
    sq: Number.EPSILON,
  });
  assert.equal(compareRuns([r]).included_count, 1);
});
test("real service recipe and saved analysis schema support line profiles", async () => {
  const { analyze } = await import("../web/service.js");
  const { saveResult } = await import("../scripts/io.mjs");
  const r = record();
  const channel = {
    id: "0",
    title: "Height",
    width: 2,
    height: 2,
    ...r.recipe.source.geometry,
    data: new Float64Array([0, 1, 2, 3]),
    mask: null,
    metadata: {},
    log: [],
    warnings: [],
    selections: {},
  };
  const result = await analyze(
    {
      file: "test.gwy",
      channel: "0",
      profile: [
        [0.5, 0.5],
        [1.5, 1.5],
      ],
    },
    {
      channels: { 0: channel },
      sha256: hash(1),
      unsupported: [],
      warnings: [],
    },
    null,
    hash(999),
  );
  const dir = await mkdtemp(join(tmpdir(), "afm-comparison-service-"));
  try {
    await saveResult(result, join(dir, "run"));
    assert.equal(await main([join(dir, "run"), "--out", join(dir, "out")]), 0);
    const report = JSON.parse(
      await readFile(join(dir, "out", "comparison.json"), "utf8"),
    );
    assert.deepEqual(report.rows[0].profile, [
      [0.5, 0.5],
      [1.5, 1.5],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
