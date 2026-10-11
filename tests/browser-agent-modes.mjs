/** Optional synthetic UI regression: all provider traffic is locally mocked. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sopPrompt } from "../web/workflow-sops.js";
import { createPreviewFixture } from "../scripts/preview-fixture.mjs";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(browserEngine));
const base = process.env.AFM_BASE_URL || "http://127.0.0.1:4186/web/";
const origin = new URL(base).origin;
const scratch = await mkdtemp(join(tmpdir(), "afm-agent-modes-"));
const secret = "synthetic-session-credential-never-export";
const browser = await playwright[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
let mode = "help",
  round = 0,
  pendingRoute = null;
const requests = [],
  errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (r) => {
    errors.push("Unexpected measurement fetch");
    return r.abort();
  });
  await page.route("**/__afm_config.json", (r) =>
    r.fulfill({ json: { model_origin: origin } }),
  );
  await page.route(origin + "/__mock_model", async (route) => {
    const body = route.request().postDataJSON();
    const payload = JSON.parse(body.messages.at(-1).content);
    requests.push({ body, payload });
    assert.equal(route.request().headers().authorization, "Bearer " + secret);
    assert.equal(JSON.stringify(body).includes(secret), false);
    if (mode === "pending") {
      pendingRoute = route;
      return;
    }
    let response;
    if (mode === "help" || mode === "bad-help")
      response = {
        answer: "Open the import control to select a supported file.",
        topic_ids: [mode === "help" ? "import-support" : "unknown-topic"],
      };
    else {
      round++;
      if (
        (mode === "auto" && round === 3) ||
        (mode === "sop-complete" && round === 2)
      )
        response = {
          kind: "evidence",
          claim_ids: [payload.evidenceContext.claims[0].claim_id],
        };
      else if (mode === "sop-complete") {
        const source = payload.sourceContexts[0];
        const identity = {
          file: source.file,
          source_sha256: source.source_sha256,
          channel: source.channel,
        };
        const selection = { roi: null, exclude_polygons: [] };
        const step = (id, name, args) => ({
          id,
          rationale:
            "Retain original values without leveling as explicitly approved for this synthetic SOP record check.",
          call: { name, arguments: args },
        });
        response = {
          kind: "plan",
          plan: {
            schema_version: 1,
            title: "Complete pilot SOP records",
            steps: [
              step("baseline", "analyze_surface", {
                ...identity,
                operations: [],
                selection,
              }),
              step("processed", "analyze_surface", {
                ...identity,
                operations: [],
                selection,
              }),
              step("quality", "check_quality", {
                ...identity,
                selection,
                boundary_sigma: 6,
              }),
              step("replay", "replay_recipe", {
                file: source.file,
                source_sha256: source.source_sha256,
                recipe_artifact: "$step:processed",
              }),
            ],
          },
        };
      } else {
        const source = payload.sourceContexts[0];
        response = {
          kind: "plan",
          plan: {
            schema_version: 1,
            title: "Synthetic round " + round,
            steps: [
              {
                id: "surface_" + round,
                rationale:
                  "Measure the explicitly selected synthetic surface" +
                  (payload.evidenceContext
                    ? " after reviewing prior verified evidence"
                    : ""),
                call: {
                  name: "analyze_surface",
                  arguments: {
                    file: source.file,
                    source_sha256: source.source_sha256,
                    channel: source.channel,
                    operations: [],
                  },
                },
              },
            ],
          },
        };
      }
    }
    await route.fulfill({
      json: {
        id: "mock-agent-modes",
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
  async function download(selector, name) {
    const event = page.waitForEvent("download");
    await page.locator(selector).click();
    const path = join(scratch, name);
    await (await event).saveAs(path);
    const text = await readFile(path, "utf8");
    assert.equal(text.includes(secret), false);
    return JSON.parse(text);
  }
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  assert.equal(await page.locator("#documentation-link").isVisible(), true);
  assert.equal(
    await page.locator("#documentation-link").getAttribute("href"),
    "./help.html",
  );
  await page.locator("#tab-assistant").click();
  await page.locator(".model-panel summary").first().click();
  for (const preset of ["openai", "gemini", "groq"]) {
    await page.locator("#model-provider").selectOption(preset);
    assert.equal(
      await page.locator("#model-endpoint").evaluate((n) => n.readOnly),
      true,
    );
    assert.match(
      await page.locator("#model-endpoint").inputValue(),
      /^https:\/\//,
    );
  }
  await page.locator("#model-provider").selectOption("custom");
  assert.equal(
    await page.locator("#model-endpoint").evaluate((n) => n.readOnly),
    false,
  );
  await page.locator("#model-endpoint").fill(origin + "/__mock_model");
  await page.locator("#model-name").fill("mock");
  await page.locator("#model-key").fill(secret);
  await page.locator("#help-agent > summary").click();
  assert.equal(await page.locator(".inspection-actions #refresh").count(), 1);
  const initialJournal = (await journal()).records.length;
  async function askHelp() {
    await page.locator("#help-question").fill("How do I import a file?");
    await page.locator("#help-send").click();
    await page.waitForFunction(
      () => !document.querySelector("#help-send").disabled,
    );
  }
  await askHelp();
  assert.match(
    await page.locator("#help-status").textContent(),
    /No analysis tools executed/,
  );
  assert.equal((await journal()).records.length, initialJournal);
  assert.deepEqual(Object.keys(requests[0].payload).sort(), [
    "documentation",
    "question",
  ]);
  assert.equal(requests[0].payload.documentation.schema_version, 1);
  assert.equal(
    await page.locator("#help-conversation a").first().getAttribute("href"),
    "help.html#import-support",
  );
  mode = "bad-help";
  await askHelp();
  assert.match(
    await page.locator("#help-status").textContent(),
    /invalid response/,
  );
  assert.equal(await page.locator("#help-conversation li").count(), 1);
  assert.equal((await journal()).records.length, initialJournal);
  const helpAudit = await download("#help-download", "help.json");
  assert.deepEqual(
    helpAudit.requests.map((r) => r.status),
    ["answered", "failed"],
  );
  const guide = await browser.newPage();
  await guide.goto(new URL("help.html#import-support", base).href);
  assert.equal(await guide.locator("#import-support").count(), 1);
  assert.deepEqual(
    await guide.locator("main > section > h2").allTextContents(),
    ["General", "Agents and automation", "Common workflows"],
  );
  assert.equal(await guide.locator("figure img").count(), 2);
  for (const photo of await guide.locator("figure img").all()) {
    await photo.scrollIntoViewIfNeeded();
    await guide.waitForFunction(
      (src) => {
        const image = [...document.images].find(
          (img) => img.getAttribute("src") === src,
        );
        return image?.complete && image.naturalWidth > 0;
      },
      await photo.getAttribute("src"),
    );
    await photo.evaluate((img) => img.decode());
    assert.ok(await photo.evaluate((img) => img.naturalWidth > 0));
  }
  assert.ok((await guide.locator("#profiles-plateaus ol li").count()) >= 6);
  assert.ok((await guide.locator("#texture ol li").count()) >= 6);
  await guide.close();

  const fixture = join(scratch, "agent-synthetic.gwy");
  await writeFile(fixture, createPreviewFixture());
  await page.locator("#import").setInputFiles(fixture);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  await page.locator("#autonomous-agent > summary").click();
  const reviewedBefore = await page.locator("#assistant-plan").inputValue();
  const beforeAuto = (await journal()).records.length;
  const requestStart = requests.length;
  mode = "auto";
  round = 0;
  await page
    .locator("#autonomous-goal")
    .fill(
      "Measure this synthetic surface, inspect the evidence, then return a recorded claim.",
    );
  await page.locator("#autonomous-start").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector("#autonomous-status").textContent ===
      "Goal evidence_returned",
  );
  assert.equal((await journal()).records.length, beforeAuto + 2);
  const autoRequests = requests.slice(requestStart);
  assert.equal(autoRequests.length, 3);
  assert.equal(autoRequests[0].payload.sourceContexts.length, 1);
  assert.equal(autoRequests[0].payload.evidenceContext, undefined);
  assert.ok(autoRequests[1].payload.evidenceContext.claims.length);
  assert.ok(autoRequests[2].payload.evidenceContext.claims.length);
  assert.equal(
    await page.locator("#assistant-plan").inputValue(),
    reviewedBefore,
  );
  const audit = await download("#autonomous-download", "autonomous.json");
  assert.equal(audit.goal.status, "evidence_returned");
  assert.equal(audit.goal.calls, 2);
  assert.equal(audit.goal.rounds.length, 3);
  assert.deepEqual(
    audit.goal.rounds.map((r) => r.status),
    ["complete", "complete", "evidence_returned"],
  );
  assert.ok(
    audit.goal.rounds
      .slice(0, 2)
      .every((r) => r.report.claims.length && r.manifest.status === "complete"),
  );
  assert.equal(
    audit.goal.rounds[2].proposal.claim_ids[0],
    autoRequests[2].payload.evidenceContext.claims[0].claim_id,
  );
  assert.equal(audit.journal.records.length, beforeAuto + 2);

  await page.locator("#autonomous-sop").selectOption("height-roughness");
  await page
    .locator("#autonomous-deviations")
    .fill("Use the original values without leveling for this pilot test.");
  mode = "bounded";
  round = 0;
  await page.locator("#autonomous-rounds").fill("1");
  await page.locator("#autonomous-start").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#autonomous-status").textContent ===
      "Goal budget_exhausted",
  );
  const bounded = await download("#autonomous-download", "bounded.json");
  assert.equal(bounded.goal.rounds.length, 1);
  assert.equal(bounded.goal.calls, 1);
  assert.match(
    bounded.goal.goal,
    /SOP height-roughness \/ version 0.1.0 \/ status pilot/,
  );
  assert.match(bounded.goal.goal, /without leveling/);
  assert.equal((await journal()).records.length, beforeAuto + 3);
  const deviations =
    "Use the original values without leveling for this pilot test.";
  assert.deepEqual(bounded.goal.sop, {
    id: "height-roughness",
    version: "0.1.0",
    guidance: sopPrompt("height-roughness"),
    approved_settings: null,
    deviations,
  });
  async function checkSop(name) {
    const beforeRequests = requests.length,
      beforeCalls = (await journal()).records.length;
    await page.locator("#autonomous-sop-check").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#autonomous-sop-report")
        .textContent.trim()
        .startsWith("{"),
    );
    const report = JSON.parse(
      await page.locator("#autonomous-sop-report").textContent(),
    );
    const exported = await download("#autonomous-download", name);
    assert.deepEqual(exported.sop_conformance, report);
    assert.equal(report.journal_head_sha256, exported.journal.head_sha256);
    assert.deepEqual(
      report.plan_sha256,
      exported.goal.rounds
        .filter((r) => r.manifest)
        .map((r) => r.manifest.plan_sha256),
    );
    assert.ok(report.plan_sha256.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
    assert.equal(
      requests.length,
      beforeRequests,
      "SOP check sends no provider request",
    );
    assert.equal(
      (await journal()).records.length,
      beforeCalls,
      "SOP check executes no tool",
    );
    return { report, exported };
  }
  const incomplete = await checkSop("sop-incomplete.json");
  assert.equal(incomplete.report.status, "incomplete");
  for (const id of ["processed", "quality", "replay", "approved_settings"])
    assert.equal(
      incomplete.report.checks.find((c) => c.id === id)?.status,
      "missing",
      id,
    );
  await page
    .getByText("Expected SOP settings (optional)", { exact: true })
    .click();
  await page.locator("#autonomous-sop-template").click();
  const settings = JSON.parse(
    await page.locator("#autonomous-sop-settings").inputValue(),
  );
  assert.deepEqual(settings.selection, { roi: null, exclude_polygons: [] });
  assert.equal(settings.justification, "");
  const invalidRequests = requests.length,
    invalidCalls = (await journal()).records.length;
  await page.locator("#autonomous-start").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#autonomous-status")
      .textContent.includes("No goal started"),
  );
  assert.equal(requests.length, invalidRequests);
  assert.equal((await journal()).records.length, invalidCalls);
  settings.justification =
    "Original values without leveling are explicitly approved to exercise reproducible pilot records on this synthetic surface.";
  await page.locator("#autonomous-sop-settings").fill(JSON.stringify(settings));
  await page.locator("#autonomous-rounds").fill("2");
  mode = "sop-complete";
  round = 0;
  await page.locator("#autonomous-start").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#autonomous-status").textContent ===
      "Goal evidence_returned",
  );
  const complete = await checkSop("sop-complete.json");
  assert.equal(complete.report.status, "records_complete");
  assert.ok(complete.report.review_required.length);
  assert.ok(complete.report.checks.every((c) => c.status === "met"));
  assert.deepEqual(complete.exported.goal.sop, {
    ...bounded.goal.sop,
    approved_settings: settings,
  });
  assert.equal(complete.exported.goal.calls, 4);
  assert.equal((await journal()).records.length, beforeAuto + 7);

  mode = "pending";
  const beforeCancel = requests.length;
  await page.locator("#autonomous-start").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#autonomous-status").textContent ===
      "Goal planning",
  );
  const pendingDeadline = Date.now() + 30000;
  while (requests.length === beforeCancel && Date.now() < pendingDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    requests.length,
    beforeCancel + 1,
    "pending provider request must arrive within 30 seconds",
  );
  await page.locator("#autonomous-stop").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#autonomous-status").textContent ===
      "Goal stopped",
  );
  const stopped = await download("#autonomous-download", "stopped.json");
  assert.equal(stopped.goal.calls, 0);
  assert.equal(stopped.goal.status, "stopped");
  assert.equal((await journal()).records.length, beforeAuto + 7);
  await pendingRoute.abort().catch(() => {});
  pendingRoute = null;
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "mobile horizontal overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      scratch,
      browserEngine,
      providerRequests: requests.length,
      automaticCalls: 7,
      helpToolCalls: 0,
    }),
  );
} finally {
  if (pendingRoute) await pendingRoute.abort().catch(() => {});
  await browser.close();
}
