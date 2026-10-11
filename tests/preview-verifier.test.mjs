import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
  readdir,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyPreview } from "../scripts/verify-preview.mjs";
const exec = promisify(execFile),
  digest = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "afm-preview-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = {
    "data/synthetic-step.gwy": "synthetic placeholder",
    "package.json": '{"type":"module"}',
    "recipes/synthetic-step-v2.json": "{}",
    "recipes/synthetic-step.json": "{}",
    "scripts/io.mjs": 'throw new Error("PACKAGED_CODE_RAN");',
    "web/recipe-interchange.js": 'throw new Error("PACKAGED_CODE_RAN");',
    "web/service.js": 'throw new Error("PACKAGED_CODE_RAN");',
    "z-final.bin": "last file",
  };
  const files = [];
  for (const path of Object.keys(contents).sort()) {
    const bytes = Buffer.from(contents[path]);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    files.push({ path, size: bytes.length, sha256: digest(bytes) });
  }
  const manifest = {
    kind: "afm_local_preview",
    schema_version: 1,
    version: "0.1.0",
    distribution_status: "local-preview",
    license_status: "not-selected",
    files,
    engine_sha256: Object.fromEntries(
      ["GWYP", "NANOSCOPE", "IGOR_IBW", "JPK_TIFF"].map((f) => [
        f,
        "a".repeat(64),
      ]),
    ),
    example: {
      source: "data/synthetic-step.gwy",
      recipe: "recipes/synthetic-step.json",
      portable_recipe: "recipes/synthetic-step-v2.json",
      expected: {
        shape: [16, 16],
        mean: 25e-9,
        min: 0,
        max: 50e-9,
        area: 64e-12,
      },
    },
  };
  const save = () =>
    writeFile(join(root, "preview-manifest.json"), JSON.stringify(manifest));
  await save();
  return { root, manifest, save };
}
test("all file hashes are checked before any packaged executable is imported", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "z-final.bin"), "last FILE");
  await assert.rejects(verifyPreview(root), /SHA-256 mismatch: z-final.bin/);
});
test("hash and byte length mismatch are distinct failures", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "z-final.bin"), "longer replacement");
  await assert.rejects(verifyPreview(root), /Size mismatch/);
});
test("complete inventory rejects missing, extra files and unrelated empty directories", async (t) => {
  for (const mode of ["missing", "extra", "directory"]) {
    const { root } = await fixture(t);
    if (mode === "missing") await rm(join(root, "z-final.bin"));
    if (mode === "extra") await writeFile(join(root, "unlisted.txt"), "extra");
    if (mode === "directory") await mkdir(join(root, "unlisted"));
    await assert.rejects(
      verifyPreview(root),
      /Missing inventory|Unexpected file|Unexpected directory/,
    );
  }
});
test("symlink root, manifest, file and directory are forbidden", async (t) => {
  for (const target of [
    "root",
    "preview-manifest.json",
    "z-final.bin",
    "web",
  ]) {
    const { root } = await fixture(t);
    if (target === "root") {
      const alias = root + "-alias";
      t.after(() => rm(alias, { force: true }));
      await symlink(root, alias);
      await assert.rejects(verifyPreview(alias), /real directory/);
    } else {
      await rename(join(root, target), join(root, target + "-original"));
      await symlink(join(root, target + "-original"), join(root, target));
      await assert.rejects(
        verifyPreview(root),
        /Symlink|Manifest must|Unexpected/,
      );
    }
  }
});
test("unsafe, unsorted, duplicate and reserved inventory paths reject", async (t) => {
  for (const path of [
    "../escape",
    "a/../b",
    "./a",
    "/absolute",
    "C:/absolute",
    "a\\b",
    "a\0b",
    "a//b",
    "a/.",
    "a/",
    "preview-manifest.json",
  ]) {
    const { root, manifest, save } = await fixture(t);
    manifest.files[0].path = path;
    await save();
    await assert.rejects(verifyPreview(root), /Unsafe|sorted/);
  }
  for (const mode of ["unsorted", "duplicate"]) {
    const { root, manifest, save } = await fixture(t);
    if (mode === "unsorted") manifest.files.reverse();
    else manifest.files.splice(1, 0, manifest.files[0]);
    await save();
    await assert.rejects(verifyPreview(root), /sorted and unique/);
  }
});
test("strict manifest schema, engine hashes, expected constants and counts reject before imports", async (t) => {
  const edits = [
    (m) => (m.extra = true),
    (m) => (m.license_status = "MIT"),
    (m) => (m.files[0].size = -1),
    (m) => (m.files[0].size = 1.5),
    (m) => (m.files[0].sha256 = "A".repeat(64)),
    (m) => (m.engine_sha256.GWYP = "a".repeat(64) + "\n"),
    (m) => (m.example.expected.mean = 0),
    (m) => (m.example.expected.shape = [16, 16, 16]),
    (m) => (m.example.recipe = "../recipe.json"),
    (m) => (m.files = Array(1001).fill(m.files[0])),
    (m) => (m.files = m.files.filter((f) => f.path !== "scripts/io.mjs")),
  ];
  for (const edit of edits) {
    const { root, manifest, save } = await fixture(t);
    edit(manifest);
    await save();
    await assert.rejects(
      verifyPreview(root),
      (error) => !error.message.includes("PACKAGED_CODE_RAN"),
    );
  }
});
test("oversized, malformed and invalid UTF8 manifests reject", async (t) => {
  for (const bytes of [
    Buffer.alloc(1048577, 32),
    Buffer.from("{broken"),
    Buffer.from([0xff]),
  ]) {
    const { root } = await fixture(t);
    await writeFile(join(root, "preview-manifest.json"), bytes);
    await assert.rejects(verifyPreview(root));
  }
});
test("verification failure is read-only and CLI reports nonzero without JSON success", async (t) => {
  const { root } = await fixture(t);
  const before = await readFile(join(root, "preview-manifest.json"));
  await writeFile(join(root, "z-final.bin"), "changed");
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-preview.mjs", "--root", root]),
    (error) =>
      error.code === 1 &&
      error.stdout === "" &&
      /Preview verification failed/.test(error.stderr),
  );
  assert.deepEqual(await readFile(join(root, "preview-manifest.json")), before);
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-preview.mjs", "--unknown"]),
    (error) => /Usage:/.test(error.stderr),
  );
});

function syntheticStep() {
  const string = (s) => Buffer.from(s + "\0");
  const uint = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const double = (n) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return b;
  };
  const item = (name, type, data) =>
    Buffer.concat([string(name), Buffer.from(type), data]);
  const object = (name, fields) => {
    const b = Buffer.concat(fields);
    return Buffer.concat([string(name), uint(b.length), b]);
  };
  const field = object("GwyDataField", [
    item("xres", "i", uint(16)),
    item("yres", "i", uint(16)),
    item("xreal", "d", double(8e-6)),
    item("yreal", "d", double(8e-6)),
    ...["xy", "z"].map((axis) =>
      item(
        "si_unit_" + axis,
        "o",
        object("GwySIUnit", [item("unitstr", "s", string("m"))]),
      ),
    ),
    item(
      "data",
      "D",
      Buffer.concat([
        uint(256),
        ...Array.from({ length: 256 }, (_, i) =>
          double(i % 16 < 8 ? 0 : 50e-9),
        ),
      ]),
    ),
  ]);
  return Buffer.concat([
    Buffer.from("GWYP"),
    object("GwyContainer", [
      item("/0/data", "o", field),
      item("/0/data/title", "s", string("Synthetic height")),
    ]),
  ]);
}
async function actualPreview(t) {
  const f = await fixture(t),
    { root, manifest, save } = f;
  for (const name of await readdir(new URL("../web/", import.meta.url)))
    if (name.endsWith(".js"))
      await copyFile(
        new URL("../web/" + name, import.meta.url),
        join(root, "web", name),
      );
  await copyFile(
    new URL("../scripts/io.mjs", import.meta.url),
    join(root, "scripts/io.mjs"),
  );
  await writeFile(join(root, manifest.example.source), syntheticStep());
  const io = await import(pathToFileURL(join(root, "scripts/io.mjs")).href),
    service = await import(pathToFileURL(join(root, "web/service.js")).href),
    interchange = await import(
      pathToFileURL(join(root, "web/recipe-interchange.js")).href
    );
  for (const format of Object.keys(manifest.engine_sha256))
    manifest.engine_sha256[format] = await io.engineIdentity(format);
  const source = await io.loadSource(join(root, manifest.example.source));
  const result = await service.analyze(
    {
      file: "synthetic-step.gwy",
      channel: "0",
      operations: [{ name: "mean", params: {} }],
    },
    source,
    null,
    manifest.engine_sha256.GWYP,
  );
  await writeFile(
    join(root, manifest.example.recipe),
    JSON.stringify(result.recipe),
  );
  await writeFile(
    join(root, manifest.example.portable_recipe),
    JSON.stringify(
      await interchange.migrateRecipe(
        result.recipe,
        source,
        null,
        manifest.engine_sha256.GWYP,
      ),
    ),
  );
  async function update() {
    const files = [];
    async function walk(dir = "") {
      for (const name of await readdir(join(root, dir), {
        withFileTypes: true,
      })) {
        const path = dir ? dir + "/" + name.name : name.name;
        if (name.isDirectory()) await walk(path);
        else if (path !== "preview-manifest.json") {
          const b = await readFile(join(root, path));
          files.push({ path, size: b.length, sha256: digest(b) });
        }
      }
    }
    await walk();
    manifest.files = files.sort((a, b) => (a.path < b.path ? -1 : 1));
    await save();
  }
  await update();
  return { ...f, source, result, update };
}
test("real copied modules verify calibration, all engine identities and both recipe forms", async (t) => {
  const { root, manifest, source, result } = await actualPreview(t);
  const verified = await verifyPreview(root);
  assert.deepEqual(verified, {
    verified: true,
    version: "0.1.0",
    files: manifest.files.length,
    engine_sha256: manifest.engine_sha256,
    source_sha256: source.sha256,
    output_sha256: result.recipe.output.sha256,
  });
  const cli = await exec(process.execPath, [
    "scripts/verify-preview.mjs",
    "--root",
    root,
  ]);
  assert.deepEqual(JSON.parse(cli.stdout), verified);
});
test("rehashing inventory cannot bypass engine identities or strict recipe replay", async (t) => {
  const f = await actualPreview(t);
  const original = f.manifest.engine_sha256.GWYP;
  f.manifest.engine_sha256.GWYP = "a".repeat(64);
  await f.save();
  await assert.rejects(verifyPreview(f.root), /Engine identity mismatch/);
  f.manifest.engine_sha256.GWYP = original;
  const path = join(f.root, f.manifest.example.recipe),
    recipe = JSON.parse(await readFile(path, "utf8"));
  recipe.output.sha256 = "a".repeat(64);
  await writeFile(path, JSON.stringify(recipe));
  await f.update();
  await assert.rejects(verifyPreview(f.root), /output|identity|match/i);
});
