#!/usr/bin/env node
/** Verify a local preview's inventory and synthetic numerical example; never modify it. */
import { lstat, readFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const MANIFEST = "preview-manifest.json",
  FORMATS = ["GWYP", "NANOSCOPE", "IGOR_IBW", "JPK_TIFF"];
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function keys(value, expected, label) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") ===
        expected.slice().sort().join("\0"),
    `Invalid ${label} fields.`,
  );
}
function safePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !/^[a-zA-Z]:/.test(path) &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}
function hash(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{64}$/.test(value) &&
    value.length === 64
  );
}
function validateManifest(m) {
  keys(
    m,
    [
      "kind",
      "schema_version",
      "version",
      "distribution_status",
      "license_status",
      "files",
      "engine_sha256",
      "example",
    ],
    "manifest",
  );
  requireValue(
    m.kind === "afm_local_preview" &&
      m.schema_version === 1 &&
      m.distribution_status === "local-preview" &&
      m.license_status === "not-selected",
    "Invalid preview identity or status.",
  );
  requireValue(
    typeof m.version === "string" &&
      m.version.trim().length > 0 &&
      m.version.length <= 200,
    "Invalid preview version.",
  );
  requireValue(
    Array.isArray(m.files) && m.files.length <= 1000,
    "Invalid file inventory limit.",
  );
  let previous = null;
  for (const file of m.files) {
    keys(file, ["path", "size", "sha256"], "file");
    requireValue(
      safePath(file.path) && file.path !== MANIFEST,
      "Unsafe or reserved inventory path.",
    );
    requireValue(
      previous === null || previous < file.path,
      "File inventory must be sorted and unique.",
    );
    requireValue(
      Number.isSafeInteger(file.size) && file.size >= 0 && hash(file.sha256),
      "Invalid file size or SHA-256.",
    );
    previous = file.path;
  }
  keys(m.engine_sha256, FORMATS, "engine identities");
  requireValue(
    FORMATS.every((f) => hash(m.engine_sha256[f])),
    "Invalid engine SHA-256.",
  );
  keys(
    m.example,
    ["source", "recipe", "portable_recipe", "expected"],
    "example",
  );
  requireValue(
    m.example.source === "data/synthetic-step.gwy" &&
      m.example.recipe === "recipes/synthetic-step.json" &&
      m.example.portable_recipe === "recipes/synthetic-step-v2.json",
    "Invalid synthetic example paths.",
  );
  keys(
    m.example.expected,
    ["shape", "mean", "min", "max", "area"],
    "expected measurements",
  );
  const e = m.example.expected;
  requireValue(
    Array.isArray(e.shape) &&
      e.shape.length === 2 &&
      e.shape.every((n) => n === 16) &&
      e.mean === 25e-9 &&
      e.min === 0 &&
      e.max === 50e-9 &&
      e.area === 64e-12,
    "Invalid synthetic expected measurements.",
  );
  return m;
}
async function inventory(root, expected) {
  const found = [];
  async function walk(relative) {
    const path = resolve(root, relative),
      info = await lstat(path);
    requireValue(
      !info.isSymbolicLink(),
      `Symlink is forbidden: ${relative || "."}`,
    );
    if (info.isDirectory()) {
      requireValue(
        !relative || [...expected].some((p) => p.startsWith(relative + "/")),
        `Unexpected directory: ${relative}`,
      );
      for (const name of await readdir(path))
        await walk(relative ? relative + "/" + name : name);
    } else {
      requireValue(info.isFile(), `Non-regular file: ${relative}`);
      requireValue(expected.has(relative), `Unexpected file: ${relative}`);
      found.push(relative);
    }
  }
  await walk("");
  requireValue(found.length === expected.size, "Missing inventory files.");
}
async function fileDigest(path) {
  const h = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    h.update(bytes);
  }
  return { size, sha256: h.digest("hex") };
}
function near(actual, expected, tolerance, label) {
  requireValue(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `Synthetic ${label} differs: ${actual}`,
  );
}
export async function verifyPreview(root) {
  root = resolve(root);
  const rootInfo = await lstat(root);
  requireValue(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    "Preview root must be a real directory.",
  );
  const manifestPath = resolve(root, MANIFEST),
    info = await lstat(manifestPath);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size <= 1048576,
    "Manifest must be a regular file no larger than 1 MiB.",
  );
  const bytes = await readFile(manifestPath);
  requireValue(bytes.length <= 1048576, "Manifest exceeds 1 MiB.");
  const manifest = validateManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  const expected = new Set([MANIFEST, ...manifest.files.map((f) => f.path)]);
  for (const path of [
    "scripts/io.mjs",
    "web/service.js",
    "web/recipe-interchange.js",
    ...["source", "recipe", "portable_recipe"].map((k) => manifest.example[k]),
  ])
    requireValue(expected.has(path), `Required packaged file missing: ${path}`);
  await inventory(root, expected);
  // Complete every size/hash check before importing any packaged executable code.
  for (const entry of manifest.files) {
    const actual = await fileDigest(resolve(root, entry.path));
    requireValue(actual.size === entry.size, `Size mismatch: ${entry.path}`);
    requireValue(
      actual.sha256 === entry.sha256,
      `SHA-256 mismatch: ${entry.path}`,
    );
  }
  const packaged = (path) => import(pathToFileURL(resolve(root, path)).href);
  const io = await packaged("scripts/io.mjs"),
    service = await packaged("web/service.js"),
    interchange = await packaged("web/recipe-interchange.js");
  const engines = {};
  for (const format of FORMATS) {
    engines[format] = await io.engineIdentity(format);
    requireValue(
      engines[format] === manifest.engine_sha256[format],
      `Engine identity mismatch: ${format}`,
    );
  }
  const source = await io.loadSource(resolve(root, manifest.example.source));
  const original = await service.analyze(
    { file: "synthetic-step.gwy", channel: "0", operations: [] },
    source,
    null,
    engines.GWYP,
  );
  requireValue(
    JSON.stringify(original.channel.shape) === "[16,16]",
    "Synthetic shape differs.",
  );
  requireValue(
    original.statistics.valid_count === 256,
    "Synthetic valid pixel count differs.",
  );
  for (const name of ["mean", "min", "max"])
    near(
      original.statistics[name],
      manifest.example.expected[name],
      1e-20,
      name,
    );
  near(original.statistics.area, manifest.example.expected.area, 1e-23, "area");
  const outputs = [];
  for (const key of ["recipe", "portable_recipe"]) {
    const value = JSON.parse(
      await readFile(resolve(root, manifest.example[key]), "utf8"),
    );
    const result = await interchange.replayRecipeInput(
      value,
      source,
      null,
      engines.GWYP,
    );
    requireValue(
      JSON.stringify(result.recipe.operations) ===
        JSON.stringify([{ name: "mean", params: {} }]),
      "Synthetic replay must use the recorded mean operation.",
    );
    near(result.statistics.mean, 0, 1e-20, "replayed mean");
    requireValue(
      result.replay_verified === true,
      "Strict recipe replay was not verified.",
    );
    requireValue(
      hash(result.recipe.output.sha256),
      "Replayed output SHA-256 is invalid.",
    );
    outputs.push(result.recipe.output.sha256);
  }
  requireValue(
    outputs[0] === outputs[1],
    "Legacy and portable recipe outputs differ.",
  );
  return {
    verified: true,
    version: manifest.version,
    files: manifest.files.length,
    engine_sha256: engines,
    source_sha256: source.sha256,
    output_sha256: outputs[0],
  };
}
async function main(args) {
  requireValue(
    args.length === 0 || (args.length === 2 && args[0] === "--root" && args[1]),
    "Usage: node scripts/verify-preview.mjs [--root DIR]",
  );
  const root = args.length
    ? args[1]
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await verifyPreview(root), null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error("Preview verification failed: " + error.message);
    process.exitCode = 1;
  });
