/** Optional browser evidence harness. No timing pass/fail thresholds. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir, cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sizes = (process.env.AFM_PERF_SIZES || "512,1024").split(",").map(Number);
assert.ok(
  sizes.length &&
    sizes.every((n) => Number.isInteger(n) && n >= 128 && n <= 2048),
  "Sizes must be integers 128..2048",
);
const port = Number(process.env.AFM_TEST_PORT || 4180);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const scratch = await mkdtemp(join(tmpdir(), "afm-browser-performance-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(size, offset) {
  const str = (s) => Buffer.from(s + "\0"),
    u = (n) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    },
    d = (n) => {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(n);
      return b;
    };
  const item = (name, type, payload) =>
    Buffer.concat([str(name), Buffer.from(type), payload]);
  const obj = (name, fields) => {
    const b = Buffer.concat(fields);
    return Buffer.concat([str(name), u(b.length), b]);
  };
  const data = Buffer.alloc(size * size * 8);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      data.writeDoubleLE(
        offset +
          1e-9 * (Math.sin(x * 0.071) + Math.cos(y * 0.053)) +
          (x + y) * 1e-12,
        8 * (y * size + x),
      );
  return Buffer.concat([
    Buffer.from("GWYP"),
    obj("GwyContainer", [
      item("/0/data/title", "s", str("Synthetic Height")),
      item(
        "/0/data",
        "o",
        obj("GwyDataField", [
          item("xres", "i", u(size)),
          item("yres", "i", u(size)),
          item("xreal", "d", d(size * 1e-9)),
          item("yreal", "d", d(size * 2e-9)),
          ...["si_unit_xy", "si_unit_z"].map((n) =>
            item(n, "o", obj("GwySIUnit", [item("unitstr", "s", str("m"))])),
          ),
          item("data", "D", Buffer.concat([u(size * size), data])),
        ]),
      ),
    ]),
  ]);
}
let browser, server;
const report = {
  schema_version: 1,
  started_at: new Date().toISOString(),
  observations_only: true,
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    viewport: { width: 1440, height: 1080 },
  },
  source: {
    commit: execFileSync(
      "git",
      ["-c", "safe.directory=" + root, "rev-parse", "HEAD"],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    modules: [],
  },
  runs: [],
};
try {
  report.source.harness_sha256 = digest(
    await readFile(new URL(import.meta.url)),
  );
  for (const name of (await readdir(join(root, "web")))
    .filter((n) => /\.(js|css|html)$/.test(n))
    .sort())
    report.source.modules.push({
      name,
      sha256: digest(await readFile(join(root, "web", name))),
    });
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), AFM_LIVE_RELOAD: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stderr.on("data", (x) => (serverLog += x));
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (x) => {
      serverLog += x;
      if (serverLog.includes("AFM Dashboard:")) resolve();
    });
    server.once("error", reject);
    server.once("exit", (code) =>
      reject(new Error("Owned server exited " + code + ": " + serverLog)),
    );
  });
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE || "playwright"
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  report.environment.browser = browser.version();
  for (const size of sizes) {
    const context = await browser.newContext({
      viewport: report.environment.viewport,
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.route("**/data/manifest.json", (r) =>
      r.fulfill({ json: { files: [] } }),
    );
    await page.route("**/data/**", (r) =>
      r.request().url().endsWith("/manifest.json") ? r.fallback() : r.abort(),
    );
    await page.goto(`http://127.0.0.1:${port}/web/`);
    await page.waitForFunction(() =>
      document.querySelector("#status")?.textContent.includes("Import a local"),
    );
    await page.evaluate(() => {
      window.perfStageStart = async () => {
        const s = {
          start: performance.now(),
          gaps: [],
          tasks: [],
          last: null,
          supported:
            PerformanceObserver.supportedEntryTypes.includes("longtask"),
        };
        if (s.supported) {
          s.observer = new PerformanceObserver((list) =>
            s.tasks.push(
              ...list
                .getEntries()
                .map((e) => ({ start: e.startTime, duration: e.duration })),
            ),
          );
          s.observer.observe({ type: "longtask" });
        }
        const tick = (t) => {
          if (s.last !== null) s.gaps.push(t - s.last);
          s.last = t;
          s.raf = requestAnimationFrame(tick);
        };
        await new Promise((resolve) =>
          requestAnimationFrame((t) => {
            s.last = t;
            s.raf = requestAnimationFrame(tick);
            resolve();
          }),
        );
        window.perfStage = s;
      };
      window.perfStageEnd = async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const s = window.perfStage;
        cancelAnimationFrame(s.raf);
        if (s.observer) {
          s.tasks.push(
            ...s.observer
              .takeRecords()
              .map((e) => ({ start: e.startTime, duration: e.duration })),
          );
          s.observer.disconnect();
        }
        const gaps = s.gaps.sort((a, b) => a - b),
          tasks = s.tasks
            .filter((e) => e.start >= s.start)
            .map((e) => e.duration);
        return {
          elapsed_ms: performance.now() - s.start,
          raf_gap_ms: {
            count: gaps.length,
            p95: gaps.length ? gaps[Math.ceil(gaps.length * 0.95) - 1] : null,
            max: gaps.length ? Math.max(...gaps) : null,
          },
          long_tasks: {
            supported: s.supported,
            count: tasks.length,
            max_ms: tasks.length ? Math.max(...tasks) : 0,
            total_ms: tasks.reduce((a, b) => a + b, 0),
          },
        };
      };
    });
    const run = { size, files: [], stages: {}, checks: {}, errors };
    report.runs.push(run);
    for (let i = 0; i < 2; i++) {
      const name = `synthetic-${size}-${i}.gwy`,
        bytes = fixture(size, i * 1e-9),
        path = join(scratch, name);
      await writeFile(path, bytes);
      run.files.push({
        name,
        path,
        bytes: bytes.length,
        sha256: digest(bytes),
        offset_m: i * 1e-9,
      });
    }
    const stage = async (name, fn) => {
      await page.evaluate(() => window.perfStageStart());
      const extra = await fn();
      run.stages[name] = {
        ...(await page.evaluate(() => window.perfStageEnd())),
        ...(extra || {}),
      };
    };
    const ready = async () => {
      await page.waitForFunction(
        () =>
          document.querySelector("#status.error") ||
          !document.querySelector("#download").disabled,
      );
      assert.equal(
        await page.locator("#status.error").count(),
        0,
        await page.locator("#status").textContent(),
      );
    };
    const snapshot = () =>
      page.evaluate(async () => {
        const s = (await import("./app.js")).getAnalysisSnapshot();
        return s ? { statistics: s.statistics, recipe: s.recipe } : null;
      });
    await stage("import_two_files_first_analysis", async () => {
      await page.locator("#import").setInputFiles(run.files.map((f) => f.path));
      await ready();
    });
    const initial = await snapshot();
    assert.equal(initial.statistics.valid_count, size * size);
    assert.ok(Number.isFinite(initial.statistics.mean));
    run.checks.initial = initial.statistics;
    run.checks.initial_recipe = initial.recipe;
    await stage("mean_subtraction", async () => {
      await page.locator("#operation").selectOption("mean");
      await page.locator("#add").click();
      await ready();
    });
    const mean = await snapshot();
    assert.equal(mean.recipe.operations.at(-1).name, "mean");
    assert.equal(mean.statistics.valid_count, size * size);
    assert.ok(
      Number.isFinite(mean.statistics.mean) &&
        Math.abs(mean.statistics.mean) < 1e-20,
    );
    run.checks.mean = mean.statistics;
    run.checks.mean_recipe = mean.recipe;
    await page.locator("#tool").selectOption("navigate");
    await stage("warm_navigation_60_wheels", () =>
      page.evaluate(async () => {
        const c = document.querySelector("#result"),
          r = c.getBoundingClientRect(),
          times = [];
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          const start = performance.now();
          c.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: i % 2 ? 40 : -40,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
          times.push(performance.now() - start);
        }
        const sorted = [...times].sort((a, b) => a - b);
        return {
          dispatch_ms: {
            samples: times,
            p95: sorted[56],
            max: Math.max(...times),
            total: times.reduce((a, b) => a + b, 0),
          },
        };
      }),
    );
    await stage("palette_change", async () => {
      await page.locator("#palette").selectOption("inferno");
      assert.equal(await page.locator("#palette").inputValue(), "inferno");
    });
    await stage("batch_two_files", async () => {
      await page.locator("#tab-batch").click();
      await page.locator("#batch-capture").click();
      await page.locator("#batch-refresh").click();
      await page.waitForFunction(
        () => document.querySelectorAll("#batch-files input").length === 2,
      );
      for (const checkbox of await page.locator("#batch-files input").all())
        await checkbox.check();
      await page.locator("#batch-start").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#batch-status.error") ||
          document.querySelectorAll('#batch-records [data-status="complete"]')
            .length === 2,
      );
      assert.equal(
        await page.locator("#batch-status.error").count(),
        0,
        await page.locator("#batch-status").textContent(),
      );
    });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#batch-download").click();
    const download = await downloadPromise;
    const manifestPath = join(scratch, `batch-${size}.json`);
    await download.saveAs(manifestPath);
    const batch = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(batch.records.length, 2);
    for (const record of batch.records) {
      assert.equal(record.status, "complete");
      assert.equal(record.result.statistics.valid_count, size * size);
      assert.ok(
        Number.isFinite(record.result.statistics.mean) &&
          Math.abs(record.result.statistics.mean) < 1e-20,
      );
      assert.equal(record.result.recipe.operations.at(-1).name, "mean");
    }
    run.checks.batch_manifest = manifestPath;
    run.checks.batch_records = batch.records;
    assert.deepEqual(errors, []);
    await context.close();
    await writeFile(
      join(scratch, "results.json"),
      JSON.stringify(report, null, 2),
    );
  }
  report.status = "complete";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const closed = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await closed;
  }
  report.finished_at = new Date().toISOString();
  await writeFile(
    join(scratch, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(join(scratch, "results.json"));
}
