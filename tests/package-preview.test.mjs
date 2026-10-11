import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { packagePreview } from "../scripts/package-preview.mjs";
const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("local preview is deterministic, data-isolated, clean-install verifiable and replayable", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "afm-preview-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const one = await packagePreview(join(scratch, "one"));
  const two = await packagePreview(join(scratch, "two"));
  assert.equal(one.sha256, two.sha256);
  const archive = await readFile(one.archive);
  assert.equal(hash(archive), one.sha256);
  assert.deepEqual(archive, await readFile(two.archive));
  assert.match(
    await readFile(one.archive + ".sha256", "utf8"),
    new RegExp("^" + one.sha256 + "  afm-dashboard-"),
  );
  const extracted = join(scratch, "clean");
  await mkdir(extracted);
  // Independent system tar validates the generated POSIX archive and extracts its inventory.
  await exec("tar", ["-xf", one.archive, "-C", extracted]);
  const roots = await readdir(extracted);
  assert.equal(roots.length, 1);
  const root = join(extracted, roots[0]);
  const manifest = JSON.parse(
    await readFile(join(root, "preview-manifest.json"), "utf8"),
  );
  assert.equal(manifest.distribution_status, "local-preview");
  assert.equal(manifest.license_status, "not-selected");
  assert.deepEqual(
    manifest.files.filter((f) => f.path.startsWith("data/")).map((f) => f.path),
    ["data/manifest.json", "data/synthetic-step.gwy"],
  );
  assert.ok(
    !manifest.files.some((f) =>
      /external|\.env|node_modules|155532|115658|142306|143358|AGENTS/.test(
        f.path,
      ),
    ),
  );
  const sampleManifest = JSON.parse(
    await readFile(join(root, "data/manifest.json"), "utf8"),
  );
  assert.deepEqual(
    sampleManifest.files.map((f) => f.name),
    ["synthetic-step.gwy"],
  );
  const before = await readFile(join(root, "preview-manifest.json"));
  const verified = JSON.parse(
    (
      await exec(process.execPath, ["scripts/verify-preview.mjs"], {
        cwd: root,
      })
    ).stdout,
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.files, manifest.files.length);
  assert.equal(
    verified.source_sha256,
    "070d5511c2b04a14a98dc9f9a5f720bc08b0c2e5b8f25a7cd403453698cd1f19",
  );
  assert.deepEqual(before, await readFile(join(root, "preview-manifest.json")));
  for (const file of [
    "engine.js",
    "service.js",
    "identity.js",
    "gwy.js",
    "nanoscope.js",
    "ibw.js",
    "jpk.js",
    "support.js",
  ])
    assert.deepEqual(
      await readFile(join(root, "web", file)),
      await readFile(new URL("../web/" + file, import.meta.url)),
    );
  const out = join(scratch, "replay");
  await exec(
    process.execPath,
    [
      "scripts/afm.mjs",
      "replay",
      "recipes/synthetic-step-v2.json",
      "--data-dir",
      "data",
      "--out",
      out,
    ],
    { cwd: root },
  );
  const replay = JSON.parse(await readFile(join(out, "recipe.json"), "utf8"));
  assert.equal(replay.output.sha256, verified.output_sha256);
  assert.equal(replay.created_at, "2000-01-01T00:00:00.000Z");
  await assert.rejects(packagePreview(join(scratch, "one")), /EEXIST/);
  assert.equal(hash(await readFile(one.archive)), one.sha256);
  const victim = join(root, "web/styles.css");
  const original = await readFile(victim);
  await writeFile(
    victim,
    Buffer.concat([original, Buffer.from("\n/* changed */")]),
  );
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-preview.mjs"], { cwd: root }),
    /Size mismatch|SHA-256 mismatch/,
  );
  await writeFile(victim, original);
  await writeFile(join(root, "extra.txt"), "unexpected");
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-preview.mjs"], { cwd: root }),
    /Unexpected file/,
  );
});
