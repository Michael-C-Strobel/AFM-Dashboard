/** Optional synthetic multi-source/evidence UI test; every provider response is mocked. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
function fixture(offset = 0, unit = "m") {
  const string = (text) => Buffer.from(text + "\0");
  const uint = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const item = (name, type, payload) =>
    Buffer.concat([string(name), Buffer.from(type), payload]);
  const object = (name, fields) => {
    const bytes = Buffer.concat(fields);
    return Buffer.concat([string(name), uint(bytes.length), bytes]);
  };
  const double = (n) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return b;
  };
  const field = object("GwyDataField", [
    item("xres", "i", uint(3)),
    item("yres", "i", uint(2)),
    item("xreal", "d", double(3e-6)),
    item("yreal", "d", double(2e-6)),
    item(
      "si_unit_xy",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string("m"))]),
    ),
    item(
      "si_unit_z",
      "o",
      object("GwySIUnit", [item("unitstr", "s", string(unit))]),
    ),
    item(
      "data",
      "D",
      Buffer.concat([
        uint(6),
        ...[0, 1, 2, 3, 4, 5].map((n) => double(n * 1e-9 + offset)),
      ]),
    ),
  ]);
  return Buffer.concat([
    Buffer.from("GWYP"),
    object("GwyContainer", [
      item("/0/data", "o", field),
      item("/0/data/title", "s", string("Height_Trace")),
    ]),
  ]);
}

const base = process.env.AFM_BASE_URL || "http://127.0.0.1:4176/web/",
  origin = new URL(base).origin;
const scratch = await mkdtemp(join(tmpdir(), "afm-model-context-browser-"));
const browserEngine = process.env.PLAYWRIGHT_BROWSER || "chromium";
if (!["chromium", "firefox", "webkit"].includes(browserEngine))
  throw new Error("Unsupported browser engine");
const browser = await playwright[browserEngine].launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE ||
    (browserEngine === "chromium"
      ? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      : undefined),
});
const requests = [],
  errors = [];
let mode = "clarification";
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(30000);
  const accessibility = [];
  async function auditView(name) {
    if (!process.env.AXE_CORE_PATH) return;
    if (!(await page.evaluate(() => !!window.axe)))
      await page.evaluate(await readFile(process.env.AXE_CORE_PATH, "utf8"));
    const result = await page.evaluate(() => axe.run(document));
    accessibility.push({ name, result });
    await writeFile(
      join(scratch, "accessibility.json"),
      JSON.stringify(accessibility, null, 2),
    );
    const failures = result.violations.filter((v) =>
      v.tags.some((tag) => /^wcag/.test(tag)),
    );
    assert.deepEqual(
      failures.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      [],
    );
  }
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/manifest.json", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ files: [] }),
    }),
  );
  await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (route) => {
    errors.push(
      "Unexpected repository measurement request: " + route.request().url(),
    );
    return route.abort();
  });
  await page.route("**/__afm_config.json", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ model_origin: origin }),
    }),
  );
  await page.route(origin + "/__mock_model", (route) => {
    const body = route.request().postDataJSON(),
      payload = JSON.parse(body.messages.at(-1).content);
    requests.push({ body, payload });
    let response = {
      kind: "clarification",
      question: "Which processing should be compared?",
    };
    if (mode === "plan" || mode === "wrong-source") {
      const contexts = payload.sourceContexts;
      response = {
        kind: "plan",
        plan: {
          schema_version: 1,
          title: "Two selected surfaces",
          steps: contexts.map((c, i) => ({
            id: "surface_" + i,
            rationale: "Measure explicit selected surface",
            call: {
              name: "analyze_surface",
              arguments: {
                file: c.file,
                source_sha256: c.source_sha256,
                channel: c.channel,
                operations: [],
              },
            },
          })),
        },
      };
      if (mode === "wrong-source")
        response.plan.steps[0].call.arguments.source_sha256 =
          contexts[1].source_sha256;
    }
    if (mode === "evidence")
      response = {
        kind: "evidence",
        claim_ids: [payload.evidenceContext.claims[0].claim_id],
      };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "mock-context",
        model: "mock",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(response) },
          },
        ],
      }),
    });
  });
  await page.goto(base);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Import a local"),
  );
  const a = join(scratch, "one.gwy"),
    b = join(scratch, "two.gwy");
  await writeFile(a, fixture());
  await writeFile(b, fixture(1e-9));
  await page.locator("#import").setInputFiles([a, b]);
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("#tab-assistant").click();
  await page.locator("#assistant-refresh").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  await page.locator(".model-panel summary").click();
  await page.locator("#model-endpoint").fill(origin + "/__mock_model");
  await page.locator("#model-name").fill("mock");
  const journal = () =>
    page.evaluate(async () => {
      const { apiFetch } = await import("./api.js");
      return (await apiFetch("/api/tool-journal")).json();
    });
  async function ask(text) {
    await page.locator("#model-prompt").fill(text);
    const before = (await journal()).records.length;
    await page.locator("#model-propose").click();
    await page.waitForFunction(
      () => !document.querySelector("#model-propose").disabled,
    );
    assert.equal(
      (await journal()).records.length,
      before,
      "provider request must not execute tools",
    );
  }
  await ask("Inspect current source");
  assert.ok(requests[0].payload.sourceContext);
  assert.equal(requests[0].payload.sourceContexts, undefined);
  assert.equal(requests[0].payload.evidenceContext, undefined);
  await page.locator("#model-add-source").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#model-conversation li").count(), 0);
  await page.locator("#assistant-source").selectOption("two.gwy");
  await page.waitForFunction(
    () => !document.querySelector("#assistant-measure").disabled,
  );
  await page.locator("#model-add-source").click();
  assert.equal(await page.locator("#model-sources li").count(), 2);
  mode = "plan";
  await ask("Compare selected sources");
  assert.equal(requests[1].payload.sourceContexts.length, 2);
  assert.equal(requests[1].payload.sourceContext, undefined);
  assert.equal(requests[1].payload.evidenceContext, undefined);
  assert.equal(
    requests[1].body.messages.length,
    2,
    "source selection clears provider history",
  );
  const proposed = JSON.parse(
    await page.locator("#assistant-plan").inputValue(),
  );
  assert.equal(proposed.steps.length, 2);
  assert.equal(await page.locator("#assistant-run").isDisabled(), true);
  mode = "wrong-source";
  await ask("Try mixed identity");
  assert.deepEqual(
    JSON.parse(await page.locator("#assistant-plan").inputValue()),
    proposed,
  );
  assert.equal(await page.locator("#model-status.error").count(), 1);
  // Produce local evidence explicitly; no model proposal is auto-executed.
  await page.locator("#assistant-validate").click();
  await page.locator("#assistant-run").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-report-create").disabled,
  );
  await page.locator("#assistant-report-create").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-report-json").disabled,
  );
  const evidenceBoxes = page.locator("#model-evidence input[type=checkbox]");
  assert.equal(await evidenceBoxes.count(), 2);
  assert.equal(await evidenceBoxes.first().isChecked(), false);
  const beforeEvidence = JSON.parse(
    await page.locator("#assistant-plan").inputValue(),
  );
  await evidenceBoxes.first().check();
  assert.equal(await page.locator("#model-conversation li").count(), 0);
  mode = "evidence";
  await ask("Show recorded evidence");
  const sent = requests.at(-1).payload.evidenceContext;
  assert.ok(sent.claims.length > 0);
  assert.equal(
    requests.at(-1).body.messages.length,
    2,
    "evidence selection resets history",
  );
  for (const prohibited of ["manifest", "journal", "recipe", "data", "profile"])
    assert.equal(Object.hasOwn(sent, prohibited), false);
  const claim = sent.claims[0],
    link = page.locator("#model-conversation a").last();
  assert.equal(
    await link.getAttribute("href"),
    "#artifact-" + claim.artifact_id.slice(9),
  );
  assert.ok(
    await page
      .locator('[id="artifact-' + claim.artifact_id.slice(9) + '"]')
      .count(),
  );
  await link.click();
  const artifact = page.locator(
    '[id="artifact-' + claim.artifact_id.slice(9) + '"]',
  );
  assert.equal(await artifact.evaluate((node) => node.open), true);
  assert.equal(
    await artifact
      .locator("summary")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const conversation = await page.locator("#model-conversation").textContent();
  assert.ok(conversation.includes(String(claim.value)));
  assert.ok(conversation.includes(claim.definition));
  assert.ok(conversation.includes("Model-selected recorded evidence"));
  assert.deepEqual(
    JSON.parse(await page.locator("#assistant-plan").inputValue()),
    beforeEvidence,
  );
  await auditView("desktop selected evidence response");
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#model-download").click();
  const auditPath = join(scratch, "audit.json");
  await (await downloadEvent).saveAs(auditPath);
  const audits = JSON.parse(await readFile(auditPath, "utf8"));
  assert.equal(audits.requests.length, 4);
  assert.equal(
    audits.requests.at(-1).evidenceContext.claims[0].claim_id,
    claim.claim_id,
  );
  await page.locator("#model-sources button").first().click();
  assert.equal(await page.locator("#model-conversation li").count(), 0);
  assert.equal(await page.locator("#model-download").isDisabled(), false);
  const requestCount = requests.length;
  await ask("Try evidence after removing its source");
  assert.equal(
    requests.length,
    requestCount,
    "Unselected evidence sources must fail before network dispatch",
  );
  assert.match(
    await page.locator("#model-status").textContent(),
    /Selected evidence could not be verified/,
  );
  await page.locator("#assistant-report-create").click();
  await page.waitForFunction(
    () => !document.querySelector("#assistant-report-create").disabled,
  );
  assert.equal(await page.locator("#model-evidence input:checked").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#model-add-source").scrollIntoViewIfNeeded();
  const bounds = await page.locator("#model-add-source").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await auditView("mobile context controls and report");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      scratch,
      browserEngine,
      requests: requests.length,
      evidenceClaims: sent.claims.length,
    }),
  );
} finally {
  await browser.close();
}
