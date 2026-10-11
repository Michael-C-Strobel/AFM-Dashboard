import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
if (typeof global.gc !== "function")
  throw new Error(
    "Run with node --expose-gc scripts/benchmark-texture.mjs SIZE",
  );
const { analyze } = await import(pathToFileURL(root + "/web/service.js"));
const { textureRecipe, textureBundle } = await import(
  pathToFileURL(root + "/web/texture-service.js")
);
const names = ["fft.js", "texture.js", "texture-service.js", "engine.js"];
const parts = await Promise.all(
  names.map((name) => readFile(root + "/web/" + name, "utf8")),
);
const digest = (v) => createHash("sha256").update(v).digest("hex");
const code = {
  sha256: digest(parts.join("\n")),
  files: names.map((name, i) => ({ name, sha256: digest(parts[i]) })),
};
const N = Number(process.argv[2]);
if (![128, 512, 1024, 1025].includes(N))
  throw Error("Pass 128, 512, 1024, or 1025");
const start = performance.now();
const data = new Float64Array(N * N);
let random = 0x12345678;
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    data[y * N + x] =
      2e-9 * Math.sin((2 * Math.PI * 7 * x) / N) +
      1e-9 * Math.cos((2 * Math.PI * 11 * y) / N) +
      (random / 4294967296 - 0.5) * 0.2e-9;
  }
const source = {
  sha256: digest(new Uint8Array(data.buffer)),
  channels: {
    0: {
      id: "0",
      title: "Synthetic calibrated height",
      width: N,
      height: N,
      xreal: N * 2e-9,
      yreal: N * 3e-9,
      xoff: 0,
      yoff: 0,
      xy_unit: "m",
      z_unit: "m",
      data,
      mask: null,
      metadata: {},
      log: [],
      warnings: [],
      selections: {},
    },
  },
  warnings: [],
  unsupported: [],
};
const identity = "e".repeat(64);
let analysisStart = performance.now();
let analysis = await analyze(
  { file: "synthetic.gwy", channel: "0", operations: [] },
  source,
  null,
  identity,
);
const analyze_ms = performance.now() - analysisStart,
  recipe = analysis.recipe;
analysis = null;
global.gc();
const before = process.memoryUsage();
const textureStart = performance.now();
let result,
  error = null;
try {
  result = await textureRecipe(
    { recipe, parameters: { detrend: "mean", window: "hann" } },
    source,
    null,
    identity,
    code,
  );
} catch (e) {
  error = e.message;
}
const texture_ms = performance.now() - textureStart,
  after_texture = process.memoryUsage();
let json_ms = null,
  bundle_ms = null,
  report_bytes = null,
  tar_bytes = null,
  parseval_relative_difference = null,
  after_json = null,
  after_bundle = null;
if (result) {
  const jsonStart = performance.now(),
    json = JSON.stringify(result.report);
  json_ms = performance.now() - jsonStart;
  report_bytes = Buffer.byteLength(json);
  after_json = process.memoryUsage();
  const bundleStart = performance.now(),
    bundle = textureBundle(result);
  bundle_ms = performance.now() - bundleStart;
  tar_bytes = bundle.byteLength;
  after_bundle = process.memoryUsage();
  parseval_relative_difference =
    Math.abs(
      result.report.psd.integral - result.report.psd.expected_mean_square,
    ) / Math.abs(result.report.psd.expected_mean_square);
}
const output = {
  size: N,
  node: process.version,
  cpu: cpus()[0].model,
  cpu_count: cpus().length,
  git_head: execFileSync(
    "git",
    ["-c", "safe.directory=" + root, "rev-parse", "HEAD"],
    { cwd: root, encoding: "utf8" },
  ).trim(),
  code,
  parameters: { detrend: "mean", window: "hann" },
  analyze_ms,
  texture_ms,
  json_ms,
  bundle_ms,
  wall_ms: performance.now() - start,
  peak_rss_kib: process.resourceUsage().maxRSS,
  before,
  after_texture,
  after_json,
  after_bundle,
  report_bytes,
  tar_bytes,
  parseval_relative_difference,
  error,
};
console.log(JSON.stringify(output));
