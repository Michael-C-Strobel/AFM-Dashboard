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
  sensitivityReport,
  verifySensitivityReport,
  sensitivityTsv,
  sensitivityBundle,
} from "../web/sensitivity-service.js";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
const exec = promisify(execFile),
  digest = (v) => createHash("sha256").update(v).digest("hex"),
  engine = "e".repeat(64);
async function identity() {
  const names = ["sensitivity.js", "sensitivity-service.js", "engine.js"],
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
function source(hash = "a") {
  return {
    sha256: hash.repeat(64),
    channels: {
      0: {
        id: "0",
        title: "Height",
        width: 3,
        height: 2,
        xreal: 3,
        yreal: 2,
        xoff: 0,
        yoff: 0,
        xy_unit: "m",
        z_unit: "m",
        data: Float64Array.from([0, 1, 2, 3, 4, 5]),
        mask: null,
        metadata: { "Import / support": "unverified" },
        warnings: [],
        log: [],
        selections: {},
      },
    },
    warnings: ["source caveat"],
    unsupported: [],
  };
}
async function inputs(withReference = false) {
  const input = source(),
    reference = withReference ? source("b") : null;
  const { recipe } = await analyze(
    {
      file: "source.gwy",
      channel: "0",
      operations: [],
      reference: reference ? { file: "reference.gwy", channel: "0" } : null,
    },
    input,
    reference,
    engine,
  );
  return {
    source: input,
    reference,
    code: await identity(),
    request: {
      baseline_recipe: recipe,
      variants: [
        {
          id: "mean",
          label: "Subtract mean",
          operations: [{ name: "mean", params: {} }],
          selection: {},
        },
        {
          id: "roi",
          label: "Left column",
          operations: [],
          selection: { roi: [0, 0, 1, 2] },
        },
        {
          id: "bad",
          label: "Empty ROI",
          operations: [],
          selection: { roi: [99, 99, 100, 100] },
        },
      ],
      assumptions: {
        calibration_note: "No calibration budget",
        model_note: "Processing alternatives",
      },
    },
  };
}
function execute(i) {
  return sensitivityReport(i.request, i.source, i.reference, engine, i.code);
}
function verify(report, i) {
  return verifySensitivityReport(report, i.source, i.reference, engine, i.code);
}
function resign(report) {
  delete report.report_sha256;
  report.report_sha256 = digest(JSON.stringify(report));
  return report;
}
function entries(bytes) {
  const out = {};
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const h = Buffer.from(bytes.subarray(offset, offset + 512)),
      name = h.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
      h.subarray(124, 136).toString().replace(/\0/g, ""),
      8,
    );
    out[name] = Buffer.from(bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test("known variants, changed population and isolated failure retain compact reproducible evidence", async () => {
  const i = await inputs(),
    before = structuredClone(i.request),
    r = await execute(i);
  assert.equal(r.status, "partial");
  assert.deepEqual(
    r.variants.map((v) => v.status),
    ["succeeded", "succeeded", "failed"],
  );
  assert.equal(r.baseline.statistics.mean, 2.5);
  assert.equal(r.variants[0].result.statistics.mean, 0);
  assert.equal(r.variants[1].result.statistics.valid_count, 2);
  assert.equal(r.variants[2].result, null);
  assert.deepEqual(i.request, before);
  assert.deepEqual(r.baseline.recipe, before.baseline_recipe);
  assert.equal(r.calibration_uncertainty.status, "not_evaluated");
  assert.ok(r.warnings.some((w) => /unverified/.test(w)));
  for (const compact of [
    r.baseline,
    ...r.variants.filter((v) => v.result).map((v) => v.result),
  ]) {
    assert.equal(compact.data, undefined);
    assert.equal(compact.original, undefined);
  }
  const timestamps = r.variants
      .filter((v) => v.result)
      .map((v) => v.result.recipe.created_at),
    verified = await verify(r, i);
  assert.deepEqual(verified, r);
  assert.deepEqual(
    verified.variants
      .filter((v) => v.result)
      .map((v) => v.result.recipe.created_at),
    timestamps,
  );
  assert.deepEqual(sensitivityBundle(verified), sensitivityBundle(r));
  const { report_sha256, ...unsigned } = r;
  assert.equal(report_sha256, digest(JSON.stringify(unsigned)));
});
test("all failed alternatives remain a partial report, and failure re-evaluation must match", async () => {
  const i = await inputs();
  i.request.variants = i.request.variants.slice(2);
  const r = await execute(i);
  assert.equal(r.status, "partial");
  assert.equal(r.variants.length, 1);
  assert.deepEqual(await verify(r, i), r);
  const forged = structuredClone(r);
  forged.request.variants[0].selection = { roi: null, exclude_polygons: [] };
  resign(forged);
  await assert.rejects(verify(forged, i), /failure did not reproduce/);
});
test("hash-valid tampering cannot substitute metrics definitions recipes status or code", async () => {
  const i = await inputs(),
    report = await execute(i);
  for (const change of [
    (r) => (r.baseline.statistics.mean = 999),
    (r) => (r.variants[0].result.statistics.sa = 999),
    (r) => (r.request.variants[0].operations = []),
    (r) => (r.variants[0].result.recipe.source.title = "edited"),
    (r) =>
      (r.variants[0].result.recipe.profile = [
        [0, 0],
        [1, 1],
      ]),
    (r) => (r.variants[0].status = "failed"),
    (r) => (r.variants[2].error = "fabricated"),
    (r) => (r.summary.metrics[0].baseline = 999),
    (r) => (r.code.sha256 = "f".repeat(64)),
  ]) {
    const forged = structuredClone(report);
    change(forged);
    resign(forged);
    await assert.rejects(verify(forged, i));
  }
  const unhashed = structuredClone(report);
  unhashed.status = "complete";
  await assert.rejects(verify(unhashed, i), /hash mismatch/);
});
test("source reference engine geometry and title are bound to baseline strict replay", async () => {
  const i = await inputs(true),
    r = await execute(i);
  assert.deepEqual(await verify(r, i), r);
  assert.ok(r.summary.metrics.some((m) => m.key === "comparison.rmse"));
  for (const mutate of [
    (j) => (j.source.sha256 = "f".repeat(64)),
    (j) => (j.reference = null),
    (j) => (j.reference.sha256 = "f".repeat(64)),
    (j) => (j.request.baseline_recipe.source.title = "edited"),
    (j) => (j.request.baseline_recipe.source.geometry.xreal = 9),
  ]) {
    const bad = structuredClone(i);
    mutate(bad);
    await assert.rejects(execute(bad));
  }
  await assert.rejects(
    sensitivityReport(i.request, i.source, i.reference, "f".repeat(64), i.code),
  );
});
test("request is detached before first await and successful recipe timestamps remain real", async () => {
  const i = await inputs();
  i.request.baseline_recipe.created_at = "2001-01-01T00:00:00.000Z";
  const pending = execute(i);
  i.request.variants[0].label = "edited after start";
  i.request.assumptions.model_note = "edited";
  const r = await pending;
  assert.equal(r.request.variants[0].label, "Subtract mean");
  assert.equal(r.model_note, "Processing alternatives");
  assert.notEqual(
    r.variants[0].result.recipe.created_at,
    r.baseline.recipe.created_at,
  );
});
test("TAR lists successful recipes only and TSV keeps every status with safe text", async () => {
  const i = await inputs();
  i.request.variants[0].label = "=SUM(1)\tline\nnext";
  const r = await execute(i),
    tsv = sensitivityTsv(r),
    files = entries(sensitivityBundle(r));
  assert.ok(files["variant-mean-recipe.json"]);
  assert.ok(files["variant-roi-recipe.json"]);
  assert.equal(files["variant-bad-recipe.json"], undefined);
  assert.ok(files["request.json"]);
  assert.match(tsv, /failed/);
  assert.match(tsv, /reason/);
  assert.ok(tsv.includes("'=SUM(1)\\tline\\nnext"));
  assert.deepEqual(
    JSON.parse(files["baseline-recipe.json"]),
    r.baseline.recipe,
  );
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
test("CLI executes requests and verifies existing reports without changing recipe timestamps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-sensitivity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.gwy"),
    requestPath = join(dir, "request.json"),
    out = join(dir, "run"),
    again = join(dir, "verified"),
    bytes = fixture();
  await writeFile(input, bytes);
  const src = await loadSource(input),
    { recipe } = await analyze(
      { file: "input.gwy", channel: "0", operations: [] },
      src,
      null,
      await engineIdentity(src.format),
    );
  const request = {
    baseline_recipe: recipe,
    variants: [
      {
        id: "mean",
        label: "Mean",
        operations: [{ name: "mean", params: {} }],
        selection: {},
      },
    ],
    assumptions: { calibration_note: "", model_note: "" },
  };
  await writeFile(requestPath, JSON.stringify(request));
  const cli = new URL("../scripts/sensitivity.mjs", import.meta.url).pathname,
    args = [cli, "--request", requestPath, "--input", input, "--out", out];
  await exec(process.execPath, args);
  const report = join(out, "report.json");
  await exec(process.execPath, [
    cli,
    "--report",
    report,
    "--input",
    input,
    "--out",
    again,
  ]);
  assert.deepEqual(
    await readFile(join(again, "sensitivity.tar")),
    await readFile(join(out, "sensitivity.tar")),
  );
  await assert.rejects(exec(process.execPath, args), /EEXIST/);
  assert.deepEqual(await readFile(input), bytes);
});
