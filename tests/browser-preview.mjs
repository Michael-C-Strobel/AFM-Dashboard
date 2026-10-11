/** Test the extracted preview, not the development checkout; no external measurements. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { packagePreview } from "../scripts/package-preview.mjs";
const exec = promisify(execFile);
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine));
const port = Number(process.env.AFM_PREVIEW_PORT || 4182);
assert.ok(
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4173,
);
const scratch = await mkdtemp(join(tmpdir(), "afm-clean-preview-"));
let server, browser;
try {
  const packaged = await packagePreview(join(scratch, "bundle"));
  const extracted = join(scratch, "extracted");
  await mkdir(extracted);
  await exec("tar", ["-xf", packaged.archive, "-C", extracted]);
  const root = join(extracted, (await readdir(extracted))[0]);
  const verified = JSON.parse(
    (
      await exec(process.execPath, ["scripts/verify-preview.mjs"], {
        cwd: root,
      })
    ).stdout,
  );
  server = spawn(process.execPath, [join(root, "scripts/serve.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AFM_LIVE_RELOAD: "0",
      AFM_MODEL_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(Error("Preview server startup timed out: " + output)),
      10000,
    );
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Preview server exited: " + code + " " + output));
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("AFM Dashboard:")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  browser = await playwright[engine].launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE ||
      (engine === "chromium"
        ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        : undefined),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  const errors = [],
    dataRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/data/"))
      dataRequests.push(new URL(request.url()).pathname);
  });
  await page.goto(`http://127.0.0.1:${port}/web/`);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  assert.equal(await page.locator("#file").inputValue(), "synthetic-step.gwy");
  assert.equal(await page.locator("#file option").count(), 1);
  assert.equal(await page.locator("#chemist").isDisabled(), true);
  async function download(id, name) {
    const pending = page.waitForEvent("download");
    await page.locator(id).click();
    const file = join(scratch, name);
    await (await pending).saveAs(file);
    return JSON.parse(await readFile(file, "utf8"));
  }
  assert.equal(await page.locator("#documentation-link").isVisible(), true);
  const guide = await browser.newPage();
  await guide.goto(`http://127.0.0.1:${port}/web/help.html`);
  assert.equal(await guide.locator("main > section").count(), 3);
  await guide
    .locator("img")
    .evaluateAll((images) => images.forEach((img) => (img.loading = "eager")));
  await guide.waitForFunction(
    () =>
      document.images.length === 2 &&
      [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
  await guide.close();
  const original = await download("#download", "original.json");
  assert.equal(original.source.sha256, verified.source_sha256);
  assert.deepEqual(original.source.geometry.shape, [16, 16]);
  assert.equal(original.source.geometry.xy_unit, "m");
  assert.equal(original.source.geometry.z_unit, "m");
  assert.equal(original.source.geometry.xreal, 8e-6);
  assert.equal(original.source.geometry.yreal, 8e-6);
  const replay = await page.evaluate(async (recipe) => {
    const { apiFetch } = await import("./api.js");
    const response = await apiFetch("/api/replay", {
      method: "POST",
      body: JSON.stringify({ recipe }),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, original);
  assert.equal(replay.replay_verified, true);
  assert.ok(Math.abs(replay.statistics.mean - 25e-9) < 1e-20);
  assert.equal(replay.statistics.valid_count, 256);
  assert.match(
    JSON.stringify(replay.channel.metadata),
    /Generated mathematical demonstration/,
  );
  await page
    .locator("#upload")
    .setInputFiles(join(root, "recipes/synthetic-step-v2.json"));
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Recipe replay complete"),
  );
  const portable = await download("#download-portable", "portable.json");
  assert.equal(portable.recipe.output.sha256, verified.output_sha256);
  assert.equal(portable.recipe.created_at, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(portable.recipe.operations, [{ name: "mean", params: {} }]);
  assert.ok(dataRequests.length > 0);
  assert.ok(
    dataRequests.every((path) =>
      ["/data/manifest.json", "/data/synthetic-step.gwy"].includes(path),
    ),
  );
  assert.deepEqual(errors, []);
  const after = JSON.parse(
    (
      await exec(process.execPath, ["scripts/verify-preview.mjs"], {
        cwd: root,
      })
    ).stdout,
  );
  assert.deepEqual(after, verified);
  console.log(
    JSON.stringify({
      status: "passed",
      browser: engine,
      version: await browser.version(),
      archive_sha256: packaged.sha256,
      files: verified.files,
      source_sha256: verified.source_sha256,
      output_sha256: verified.output_sha256,
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
