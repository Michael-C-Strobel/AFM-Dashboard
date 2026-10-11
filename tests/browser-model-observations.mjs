/** Synthetic autonomous observation regression; provider responses are locally mocked. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine));
const base = process.env.AFM_BASE_URL || "http://127.0.0.1:4191/web/",
  origin = new URL(base).origin;
const scratch = await mkdtemp(join(tmpdir(), "afm-browser-observations-"));
const secret = "synthetic-observation-key-never-export";
const browser = await playwright[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
let scenario = "quality",
  round = 0;
const requests = [],
  errors = [];
const identity = (s) => ({
  file: s.file,
  source_sha256: s.source_sha256,
  channel: s.channel,
});
const plan = (steps) => ({
  kind: "plan",
  plan: { schema_version: 1, title: "Synthetic observation adaptation", steps },
});
const step = (id, name, args) => ({
  id,
  rationale:
    "Inspect recorded synthetic measurements within the selected source.",
  call: { name, arguments: args },
});
function assertCompact(payload) {
  // Inspect only the transmitted observations, not catalog words or JSON-schema properties.
  const blocked = new Set([
    "medians",
    "adjacent_differences",
    "candidates",
    "overview",
    "normalized_overview",
    "cuts",
    "recipe",
    "input_recipe",
    "baseline_recipe",
    "rasters",
    "labels",
    "regions",
    "excluded_regions",
    "data",
  ]);
  function walk(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!blocked.has(key), "Unexpected observation field: " + key);
      walk(item);
    }
  }
  walk(payload.observationsContext);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (r) => {
    errors.push("Unexpected external measurement fetch");
    return r.abort();
  });
  await page.route("**/__afm_config.json", (r) =>
    r.fulfill({ json: { model_origin: origin } }),
  );
  await page.route(origin + "/__mock_observations", async (route) => {
    const body = route.request().postDataJSON(),
      payload = JSON.parse(body.messages.at(-1).content);
    requests.push({ scenario, round: ++round, body, payload });
    assert.equal(route.request().headers().authorization, "Bearer " + secret);
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal(payload.sourceContexts.length, 1);
    assertCompact(payload);
    const source = payload.sourceContexts[0];
    let response;
    if (round === 1) {
      assert.equal(payload.observationsContext, undefined);
      response = plan([
        step("quality", "check_quality", {
          ...identity(source),
          boundary_sigma: 6,
        }),
      ]);
    } else if (scenario === "mixed" && round === 2) {
      assert.ok(
        payload.observationsContext.observations.some(
          (o) => o.tool === "check_quality",
        ),
      );
      response = plan([
        step("surface", "analyze_surface", {
          ...identity(source),
          operations: [],
        }),
        step("texture", "measure_texture", {
          file: source.file,
          source_sha256: source.source_sha256,
          recipe_artifact: "$step:surface",
          parameters: { detrend: "mean", window: "boxcar" },
        }),
      ]);
    } else {
      const observations = payload.observationsContext.observations;
      assert.ok(observations.length);
      const wanted = scenario === "mixed" ? "measure_texture" : "check_quality",
        selected = observations.find((o) => o.tool === wanted);
      assert.ok(selected, "Expected recorded " + wanted + " observation");
      if (scenario === "mixed")
        assert.ok(
          payload.evidenceContext.claims.length,
          "Surface claims remain separate from texture observations",
        );
      else
        assert.equal(
          payload.evidenceContext,
          undefined,
          "Quality-only feedback requires no surface evidence",
        );
      response = {
        kind: "observations",
        observation_ids: [
          scenario === "invalid"
            ? "invented-observation-id"
            : selected.observation_id,
        ],
      };
    }
    await route.fulfill({
      json: {
        id: "mock-observation-response",
        model: "mock",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(response) },
          },
        ],
      },
    });
  });
  const journal = () =>
    page.evaluate(async () => {
      const { apiFetch } = await import("./api.js");
      return (await apiFetch("/api/tool-journal")).json();
    });
  async function download(name) {
    const event = page.waitForEvent("download");
    await page.locator("#autonomous-download").click();
    const path = join(scratch, name);
    await (await event).saveAs(path);
    const text = await readFile(path, "utf8");
    assert.ok(!text.includes(secret));
    return JSON.parse(text);
  }
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  const fixture = join(scratch, "observations-synthetic.gwy");
  await writeFile(fixture, createPreviewFixture());
  await page.locator("#import").setInputFiles(fixture);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("#tab-assistant").click();
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  await page.locator(".model-panel summary").first().click();
  await page.locator("#model-provider").selectOption("custom");
  await page.locator("#model-endpoint").fill(origin + "/__mock_observations");
  await page.locator("#model-name").fill("mock");
  await page.locator("#model-key").fill(secret);
  await page.locator("#autonomous-agent > summary").click();
  await page.locator("#autonomous-rounds").fill("4");
  const reviewedBefore = await page.locator("#assistant-plan").inputValue();
  for (const name of ["quality", "mixed", "invalid"]) {
    scenario = name;
    round = 0;
    const before = (await journal()).records.length,
      start = requests.length;
    await page
      .locator("#autonomous-goal")
      .fill(
        "Inspect acquisition quality" +
          (name === "mixed"
            ? ", then measure spatial texture using mean detrending and boxcar window"
            : "") +
          " and return recorded observations.",
      );
    await page.locator("#autonomous-start").click();
    await page.waitForFunction(
      (status) =>
        document.querySelector("#autonomous-status").textContent ===
        "Goal " + status,
      name === "invalid" ? "failed" : "observations_returned",
    );
    const audit = await download(name + ".json"),
      sent = requests.slice(start),
      calls = name === "mixed" ? 3 : 1;
    assert.equal(sent.length, name === "mixed" ? 3 : 2);
    assert.equal(audit.goal.calls, calls);
    assert.equal((await journal()).records.length, before + calls);
    assert.equal(
      await page.locator("#assistant-plan").inputValue(),
      reviewedBefore,
    );
    const terminal = audit.goal.rounds.at(-1);
    if (name === "invalid") {
      assert.equal(audit.goal.status, "failed");
      assert.ok(
        !terminal.proposal || terminal.proposal.kind !== "observations",
      );
      assert.ok(
        !(await page.locator("#autonomous-output").textContent()).includes(
          "invented-observation-id",
        ),
      );
    } else {
      assert.equal(audit.goal.status, "observations_returned");
      const observation = sent
        .at(-1)
        .payload.observationsContext.observations.find(
          (o) => o.observation_id === terminal.proposal.observation_ids[0],
        );
      assert.ok(observation);
      assert.match(observation.artifact_id, /^artifact:[0-9a-f]{64}$/);
      const projection = sent.at(-1).payload.observationsContext;
      assert.match(projection.plan_sha256, /^[0-9a-f]{64}$/);
      assert.match(projection.journal_head_sha256, /^[0-9a-f]{64}$/);
      assert.ok(
        audit.goal.rounds.some(
          (r) => JSON.stringify(r.observations) === JSON.stringify(projection),
        ),
        "Exact transmitted projection and integrity hashes retained",
      );
      const recorded = audit.goal.rounds
        .flatMap((r) => r.observations?.observations || [])
        .find((o) => o.observation_id === observation.observation_id);
      assert.deepEqual(
        recorded,
        observation,
        "Exact sent summaries, warnings and identities retained in audit",
      );
      const rendered = JSON.parse(
        await page.locator("#autonomous-output").textContent(),
      );
      assert.ok(JSON.stringify(rendered).includes(observation.observation_id));
      assert.ok(
        JSON.stringify(rendered).includes(JSON.stringify(observation.summary)),
        "Exact recorded summary rendered",
      );
      assert.deepEqual(
        observation.source,
        identity(sent.at(-1).payload.sourceContexts[0]),
      );
      const summary = observation.summary;
      if (name === "quality") {
        assert.equal(summary.counts.selected, 256);
        assert.equal(summary.counts.invalid, 0);
        assert.equal(summary.rows.candidate_count, 0);
        assert.equal(summary.columns.candidate_count, 1);
        assert.deepEqual(summary.units, { xy: "m", z: "m" });
      } else {
        // Analytic variance of x + 2*y + 5*I(x>=8), x,y uniform 0..15: 132.5 nm².
        for (const value of [
          summary.psd.integral,
          summary.psd.expected_mean_square,
          summary.acf.zero_lag,
        ])
          assert.ok(Math.abs(value - 132.5e-18) < 1e-28);
        assert.equal(summary.psd.integral_unit, "(m)²");
        assert.equal(summary.acf.unit, "(m)²");
        assert.equal(summary.parameters.detrend, "mean");
        assert.equal(summary.parameters.window, "boxcar");
      }
      assert.ok(
        observation.warnings.length,
        "Interpretation and calibration warnings retained",
      );
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      scratch,
      browserEngine,
      providerRequests: requests.length,
      toolCalls: 5,
      scenarios: [
        "quality-only",
        "quality-to-texture",
        "invalid-observation-id",
      ],
    }),
  );
} finally {
  await browser.close();
}
