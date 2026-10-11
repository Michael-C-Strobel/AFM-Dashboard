/** Optional browser QA with intercepted provider responses, never a live model. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 },
  acceptDownloads: true,
});
const scratch = await mkdtemp(join(tmpdir(), "afm-model-browser-"));
const errors = [],
  requests = [];
page.on("pageerror", (error) => errors.push(error.message));
const secret = "test-only-credential-do-not-export";
let mode = "clarify",
  release;
await page.route("https://provider.example/**", async (route) => {
  const request = route.request();
  if (request.method() === "OPTIONS")
    return route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "POST",
      },
    });
  const body = request.postDataJSON();
  requests.push(body);
  assert.equal(request.headers().authorization, "Bearer " + secret);
  const context = JSON.parse(body.messages.at(-1).content).sourceContext;
  assert.deepEqual(Object.keys(context).sort(), [
    "channel",
    "file",
    "geometry",
    "source_sha256",
    "title",
    "units",
    "warnings",
  ]);
  assert.ok(!JSON.stringify(body).includes(secret));
  let proposal;
  if (mode === "clarify")
    proposal = {
      kind: "clarification",
      question: "Measure the original values or remove a plane first?",
    };
  else if (mode === "reflect")
    proposal = { kind: "clarification", question: secret };
  else if (mode === "hold") {
    await new Promise((resolve) => {
      release = resolve;
    });
    proposal = { kind: "clarification", question: "Late response" };
  } else
    proposal = {
      kind: "plan",
      plan: {
        schema_version: 1,
        title: "Measure original height",
        steps: [
          {
            id: "measure",
            rationale: "Use original values with explicit units.",
            call: {
              name: "analyze_surface",
              arguments: {
                file: context.file,
                source_sha256: context.source_sha256,
                channel: context.channel,
                operations: [],
              },
            },
          },
          {
            id: "replay",
            call: {
              name: "replay_recipe",
              arguments: {
                file: context.file,
                source_sha256: context.source_sha256,
                recipe_artifact: "$step:measure",
              },
            },
          },
        ],
      },
    };
  await route
    .fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        id: "mock-response",
        model: "mock-model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(proposal) },
          },
        ],
      }),
    })
    .catch(() => {});
});
async function journal() {
  return page.evaluate(async () => {
    const { apiFetch } = await import("./api.js");
    return (await apiFetch("/api/tool-journal")).json();
  });
}
async function finished() {
  await page.waitForFunction(
    () => !document.querySelector("#model-propose").disabled,
  );
}
async function download(id, name) {
  const event = page.waitForEvent("download");
  await page.locator(id).click();
  const path = join(scratch, name);
  await (await event).saveAs(path);
  return JSON.parse(await readFile(path, "utf8"));
}
try {
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/");
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("#tab-assistant").click();
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  const initial = await journal();
  await page.locator(".model-panel summary").first().click();
  await page
    .locator("#model-endpoint")
    .fill("https://provider.example/v1/chat/completions");
  await page.locator("#model-name").fill("mock-model");
  await page.locator("#model-key").fill(secret);
  await page
    .locator("#model-prompt")
    .fill("Measure roughness; ask if processing is unclear.");
  await page.locator("#model-propose").click();
  await finished();
  assert.match(
    await page.locator("#model-status").textContent(),
    /clarification/,
  );
  assert.equal((await journal()).records.length, initial.records.length);
  mode = "plan";
  await page
    .locator("#model-prompt")
    .fill("Use original values and verify with strict replay.");
  await page.locator("#model-propose").click();
  await finished();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.length, 4);
  assert.equal((await journal()).records.length, initial.records.length);
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  assert.equal(
    JSON.parse(await page.locator("#assistant-plan").inputValue()).steps.length,
    2,
  );
  await page.locator("#assistant-validate").click();
  await page.locator("#assistant-run").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-validate").disabled,
  );
  const run = await download("#assistant-download-run", "run.json");
  assert.equal(run.status, "complete");
  const audit = await download("#model-download", "conversation.json");
  assert.equal(audit.requests.length, 2);
  assert.equal(audit.requests[1].proposal_plan_sha256, run.plan_sha256);
  assert.ok(!JSON.stringify(audit).includes(secret));
  assert.ok(
    audit.requests[1].request.messages[2].content.includes("clarification"),
  );
  const beforeInvalid = await journal();
  mode = "reflect";
  await page.locator("#model-prompt").fill("Another proposal");
  await page.locator("#model-propose").click();
  await finished();
  assert.match(
    await page.locator("#model-status").textContent(),
    /invalid.*unsafe/,
  );
  assert.ok(
    !(await page.locator("#model-conversation").textContent()).includes(secret),
  );
  assert.equal((await journal()).records.length, beforeInvalid.records.length);
  mode = "hold";
  await page.locator("#model-prompt").fill("Wait for cancellation");
  await page.locator("#model-propose").click();
  await page.waitForTimeout(100);
  await page.locator("#model-cancel").click();
  await finished();
  release?.();
  assert.match(await page.locator("#model-status").textContent(), /canceled/);
  await page.locator("#model-clear-key").click();
  assert.equal(await page.locator("#model-key").inputValue(), "");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        provider: "intercepted mock only",
        checks: [
          "clarification history",
          "no tools during proposal",
          "explicit execution",
          "plan-audit binding",
          "credential redaction",
          "cancellation",
          "mobile",
        ],
        scratch,
      },
      null,
      2,
    ),
  );
} finally {
  release?.();
  await browser.close();
}
