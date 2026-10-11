import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { analyze } from "../web/service.js";
import { loadSource, engineIdentity } from "../scripts/io.mjs";
import { canonicalRecipeJSON } from "../web/recipe-interchange.js";
const exec = promisify(execFile);
const cli = (name, args) =>
  exec(process.execPath, [
    new URL("../scripts/" + name + ".mjs", import.meta.url).pathname,
    ...args,
  ]);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
function reorder(v) {
  return Array.isArray(v)
    ? v.map(reorder)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .reverse()
            .map((k) => [k, reorder(v[k])]),
        )
      : v;
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "afm-recipe-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, "input.gwy"),
    legacy = join(dir, "legacy.json"),
    portable = join(dir, "portable.json");
  await writeFile(input, fixture());
  const source = await loadSource(input),
    { recipe } = await analyze(
      {
        file: "input.gwy",
        channel: "0",
        operations: [{ name: "mean", params: {} }],
      },
      source,
      null,
      await engineIdentity(source.format),
    );
  await writeFile(legacy, JSON.stringify(recipe));
  return { dir, input, legacy, portable, recipe };
}
const migrate = (i) =>
  cli("recipe", [
    "migrate",
    "--recipe",
    i.legacy,
    "--input",
    i.input,
    "--out",
    i.portable,
  ]);
const verify = (i, path = i.portable, input = i.input) =>
  cli("recipe", ["verify", "--recipe", path, "--input", input]);

function fixture(offset = 0, unit = "m", values = [0, 1, 2, 3, 4, 5]) {
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
      Buffer.concat([uint(6), ...values.map((n) => double(n * 1e-9 + offset))]),
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

test("migration and recursively reordered portable CLI replay preserve recorded identities", async (t) => {
  const i = await setup(t),
    output = JSON.parse((await migrate(i)).stdout),
    document = await json(i.portable);
  assert.equal(output.schema_version, 2);
  assert.equal(document.recipe.created_at, i.recipe.created_at);
  assert.deepEqual(document.recipe.environment, i.recipe.environment);
  assert.equal(JSON.parse((await verify(i, i.legacy)).stdout).verified, true);
  const reordered = join(i.dir, "reordered.json");
  await writeFile(reordered, JSON.stringify(reorder(document)));
  const verified = JSON.parse((await verify(i, reordered)).stdout);
  assert.equal(verified.verified, true);
  assert.equal(verified.interchange.document_sha256, document.document_sha256);
  const out = join(i.dir, "replay");
  await cli("afm", ["replay", reordered, "--data-dir", i.dir, "--out", out]);
  const replayed = await json(join(out, "recipe.json"));
  assert.deepEqual(replayed.output, i.recipe.output);
  assert.equal(replayed.created_at, i.recipe.created_at);
  assert.deepEqual(
    await json(join(out, "input-recipe-document.json")),
    reorder(document),
  );
});
test("tampered checksums scientific edits wrong input and overwrites are rejected", async (t) => {
  const i = await setup(t);
  await migrate(i);
  const original = await readFile(i.portable),
    doc = JSON.parse(original);
  doc.recipe.source.title = "edited";
  const edited = join(i.dir, "edited.json");
  await writeFile(edited, JSON.stringify(doc));
  await assert.rejects(verify(i, edited));
  const digest = (v) =>
    createHash("sha256").update(canonicalRecipeJSON(v)).digest("hex");
  doc.recipe_sha256 = digest(doc.recipe);
  delete doc.document_sha256;
  doc.document_sha256 = digest(doc);
  await writeFile(edited, JSON.stringify(doc));
  await assert.rejects(verify(i, edited));
  const wrong = join(i.dir, "wrong.gwy");
  await writeFile(wrong, fixture(1e-9));
  await assert.rejects(verify(i, i.portable, wrong));
  await assert.rejects(migrate(i), /EEXIST/);
  assert.deepEqual(await readFile(i.portable), original);
  await assert.rejects(
    cli("recipe", [
      "migrate",
      "--recipe",
      i.legacy,
      "--input",
      i.input,
      "--out",
      i.input,
    ]),
    /EEXIST/,
  );
  assert.deepEqual(await readFile(i.input), fixture());
});
test("portable batch retains compatible gates and resumes semantic key reorder", async (t) => {
  const i = await setup(t);
  await migrate(i);
  const document = reorder(await json(i.portable));
  await writeFile(i.portable, JSON.stringify(document));
  const out = join(i.dir, "batch");
  const args = ["batch", i.portable, i.input, "--out", out];
  await cli("afm", args);
  const first = await json(join(out, "batch.json"));
  assert.equal(first.records[0].status, "complete");
  const recipePath = join(first.records[0].out, "recipe.json"),
    saved = await json(recipePath);
  saved.selection = reorder(saved.selection);
  await writeFile(recipePath, JSON.stringify(saved));
  await cli("afm", [...args, "--resume"]);
  assert.equal((await json(join(out, "batch.json"))).records[0].resumed, true);
  assert.deepEqual(
    await json(join(out, "input-recipe-document.json")),
    document,
  );
  const bad = structuredClone(document);
  bad.recipe.source.title = "Different";
  const digest = (v) =>
    createHash("sha256").update(canonicalRecipeJSON(v)).digest("hex");
  bad.recipe_sha256 = digest(bad.recipe);
  delete bad.document_sha256;
  bad.document_sha256 = digest(bad);
  const path = join(i.dir, "bad-template.json");
  await writeFile(path, JSON.stringify(bad));
  await assert.rejects(
    cli("afm", ["batch", path, i.input, "--out", join(i.dir, "bad-batch")]),
    (error) => error.code === 1 && /incompatible/.test(error.stdout),
  );
});
test("derivation CLIs decode portable inputs and retain source documents beside unchanged reports", async (t) => {
  const i = await setup(t);
  await migrate(i);
  const document = reorder(await json(i.portable));
  await writeFile(i.portable, JSON.stringify(document));
  for (const name of ["segment", "texture"]) {
    const out = join(i.dir, name);
    await cli(name, [
      "--recipe",
      i.portable,
      "--input",
      i.input,
      "--out",
      out,
      ...(name === "segment" ? ["--threshold", "0"] : []),
    ]);
    const report = await json(join(out, "report.json"));
    assert.equal(report.input_recipe.created_at, i.recipe.created_at);
    assert.equal(report.input_recipe.schema_version, 1);
    assert.deepEqual(report.input_recipe.output, i.recipe.output);
    assert.deepEqual(
      await json(join(out, "input-recipe-document.json")),
      document,
    );
  }
  const out = join(i.dir, "registration");
  await cli("register", [
    "--fixed-recipe",
    i.portable,
    "--moving-recipe",
    i.portable,
    "--fixed",
    i.input,
    "--moving",
    i.input,
    "--out",
    out,
  ]);
  assert.equal((await json(join(out, "report.json"))).metrics.rmse, 0);
  for (const prefix of ["fixed", "moving"])
    assert.deepEqual(
      await json(join(out, prefix + "-input-recipe-document.json")),
      document,
    );
});
test("sensitivity request baseline decodes while saved report verification stays byte-faithful", async (t) => {
  const i = await setup(t);
  await migrate(i);
  const doc = reorder(await json(i.portable)),
    request = {
      baseline_recipe: doc,
      variants: [
        {
          id: "zero",
          label: "Zero minimum",
          operations: [{ name: "zero_min", params: {} }],
          selection: {},
        },
      ],
      assumptions: { calibration_note: "", model_note: "" },
    },
    path = join(i.dir, "request.json"),
    out = join(i.dir, "sensitivity");
  await writeFile(path, JSON.stringify(request));
  await cli("sensitivity", [
    "--request",
    path,
    "--input",
    i.input,
    "--out",
    out,
  ]);
  assert.deepEqual(await json(join(out, "input-recipe-document.json")), doc);
  const report = join(out, "report.json"),
    verified = join(i.dir, "verified");
  await cli("sensitivity", [
    "--report",
    report,
    "--input",
    i.input,
    "--out",
    verified,
  ]);
  assert.deepEqual(
    await readFile(join(verified, "sensitivity.tar")),
    await readFile(join(out, "sensitivity.tar")),
  );
});

test("migration and verification require the recorded reference input", async (t) => {
  const i = await setup(t),
    source = await loadSource(i.input);
  const { recipe } = await analyze(
    {
      file: "input.gwy",
      channel: "0",
      operations: [],
      reference: { file: "reference.gwy", channel: "0" },
    },
    source,
    source,
    await engineIdentity(source.format),
  );
  await writeFile(i.legacy, JSON.stringify(recipe));
  await assert.rejects(migrate(i));
  await cli("recipe", [
    "migrate",
    "--recipe",
    i.legacy,
    "--input",
    i.input,
    "--reference",
    i.input,
    "--out",
    i.portable,
  ]);
  await assert.rejects(verify(i));
  const verified = await cli("recipe", [
    "verify",
    "--recipe",
    i.portable,
    "--input",
    i.input,
    "--reference",
    i.input,
  ]);
  assert.equal(JSON.parse(verified.stdout).verified, true);
});
