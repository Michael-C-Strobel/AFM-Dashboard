/** Optional synthetic UI regression: all provider traffic is locally mocked. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      if (mode === "auto" && round === 3)
        response = {
          kind: "evidence",
          claim_ids: [payload.evidenceContext.claims[0].claim_id],
        };
      else {
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
  assert.equal((await journal()).records.length, beforeAuto + 3);

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
  assert.equal((await journal()).records.length, beforeAuto + 3);
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
      automaticCalls: 3,
      helpToolCalls: 0,
    }),
  );
} finally {
  if (pendingRoute) await pendingRoute.abort().catch(() => {});
  await browser.close();
}
