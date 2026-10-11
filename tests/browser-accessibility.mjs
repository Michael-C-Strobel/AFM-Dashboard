/** Optional Chromium/axe audit. Serve this checkout separately; no app dependencies. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
if (!process.env.AXE_CORE_PATH)
  throw Error("Set AXE_CORE_PATH to axe-core 4.10.3 axe.min.js");
const axeSource = await readFile(process.env.AXE_CORE_PATH, "utf8");
const scratch = await mkdtemp(join(tmpdir(), "afm-accessibility-audit-"));
console.log("Accessibility evidence: " + scratch);
await writeFile(
  join(scratch, "progress.md"),
  "# Accessibility audit\n\nStarted; complete JSON and per-view counts will be retained here.\n",
);
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

const tabs = [
  "measurements",
  "acquisition",
  "batch",
  "assistant",
  "features",
  "texture",
  "registration",
  "sensitivity",
];
async function populate(page) {
  const steps = [];
  const tab = async (name) => page.locator("#tab-" + name).click();
  const enabled = async (id) =>
    page.waitForFunction((id) => !document.getElementById(id).disabled, id);
  await tab("acquisition");
  await page.locator("#acquisition-check").click();
  await enabled("acquisition-export");
  steps.push("Acquisition: explicitly checked imported synthetic source.");
  await tab("batch");
  await page.locator("#batch-refresh").click();
  await page.locator("#batch-capture").click();
  await page.locator('#batch-files input[type="checkbox"]').first().check();
  await page.locator("#batch-start").click();
  await enabled("batch-download");
  steps.push(
    "Batch: captured current recipe, selected only imported fixture, started batch.",
  );
  await tab("assistant");
  await page.locator("#assistant-refresh").click();
  await enabled("assistant-measure");
  await page.locator("#assistant-measure").click();
  await page.locator("#assistant-validate").click();
  await page.locator("#assistant-run").click();
  await enabled("assistant-download-run");
  await enabled("assistant-report-create");
  await page.locator("#assistant-report-create").click();
  await enabled("assistant-report-json");
  steps.push(
    "Assistant: local measure starter, explicit validation/run and verified evidence; no provider.",
  );
  await tab("features");
  await page.locator("#features-capture").click();
  await page.locator("#features-threshold").fill("0");
  await page.locator("#features-run").click();
  await enabled("features-json");
  steps.push(
    "Features: captured processed analysis and explicitly segmented at threshold zero.",
  );
  await tab("texture");
  await page.locator("#texture-capture").click();
  await page.locator("#texture-run").click();
  await enabled("texture-json");
  steps.push(
    "Texture: captured processed analysis and measured default mean/boxcar texture.",
  );
  await tab("registration");
  await page.locator("#registration-capture-fixed").click();
  await page.locator("#registration-capture-moving").click();
  await page.locator("#registration-run").click();
  await enabled("registration-json");
  steps.push(
    "Registration: captured same processed source twice and ran explicit zero manual translation.",
  );
  await tab("sensitivity");
  await page.locator("#sensitivity-capture").click();
  await page.locator("#sensitivity-add-mean").click();
  await page.locator("#sensitivity-run").click();
  await enabled("sensitivity-json");
  steps.push(
    "Sensitivity: captured baseline, added mean alternative and explicitly ran review.",
  );
  return steps;
}
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const report = {
  axe_version: "4.10.3",
  base_url: process.env.AFM_BASE_URL || "http://127.0.0.1:4178/web/",
  views: [],
  errors: [],
};
try {
  const source = join(scratch, "synthetic.gwy");
  await writeFile(source, fixture());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(30000);
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.route("**/data/manifest.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ files: [] }),
      }),
    );
    await page.route(/\/data\/.*\.(?:gwy|spm|ibw|jpk)(?:\?|$)/, (route) => {
      report.errors.push(
        "Unexpected repository data request: " + route.request().url(),
      );
      return route.abort();
    });
    await page.goto(report.base_url);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("Import a local"),
    );
    await page.locator("#import").setInputFiles(source);
    await page.waitForFunction(
      () => !document.querySelector("#download").disabled,
    );
    await page.evaluate(axeSource);
    assert.equal(await page.evaluate(() => axe.version), "4.10.3");
    for (const state of ["initial", "populated"]) {
      const populationSteps = state === "populated" ? await populate(page) : [];
      for (const mode of ["normal", "expanded"]) {
        if (mode === "expanded")
          await page.locator("#expand-inspection").click();
        for (const tab of tabs) {
          await page.locator("#tab-" + tab).click();
          assert.equal(await page.locator("#panel-" + tab).isVisible(), true);
          const semantics = await page.evaluate(() => {
            const dialog = document.querySelector("#inspection-dialog");
            const visible = (e) =>
              !!e.getClientRects().length &&
              getComputedStyle(e).visibility !== "hidden" &&
              (!dialog.open || dialog.contains(e));
            const selector = (e) =>
              e.id ? "#" + e.id : e.tagName.toLowerCase();
            return {
              dialog: {
                open: dialog.open,
                modal: dialog.matches(":modal"),
                role: dialog.getAttribute("role"),
                label: dialog.getAttribute("aria-label"),
                labelledby: dialog.getAttribute("aria-labelledby"),
                focusInside: dialog.contains(document.activeElement),
              },
              controls: [
                ...document.querySelectorAll("button,select,input,textarea"),
              ]
                .filter(visible)
                .map((e) => ({
                  selector: selector(e),
                  tag: e.tagName,
                  type: e.type,
                  disabled: e.disabled,
                  labels: [...(e.labels || [])].map((l) =>
                    l.textContent.trim(),
                  ),
                  ariaLabel: e.getAttribute("aria-label"),
                  ariaLabelledby: e.getAttribute("aria-labelledby"),
                  text: e.textContent.trim().slice(0, 300),
                })),
              liveRegions: [
                ...document.querySelectorAll(
                  '[role="status"],[role="alert"],[aria-live]',
                ),
              ]
                .filter(visible)
                .map((e) => ({
                  selector: selector(e),
                  role: e.getAttribute("role"),
                  live: e.getAttribute("aria-live"),
                  text: e.textContent.trim().slice(0, 300),
                })),
              headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
                .filter(visible)
                .map((e) => ({
                  selector: selector(e),
                  level: e.tagName,
                  text: e.textContent.trim(),
                })),
              landmarks: [
                ...document.querySelectorAll(
                  'main,nav,header,footer,aside,[role="region"],[role="main"]',
                ),
              ]
                .filter(visible)
                .map((e) => ({
                  selector: selector(e),
                  tag: e.tagName,
                  role: e.getAttribute("role"),
                  label: e.getAttribute("aria-label"),
                })),
            };
          });
          if (mode === "expanded") {
            assert.equal(semantics.dialog.modal, true);
            assert.equal(semantics.dialog.focusInside, true);
            assert.ok(
              semantics.dialog.label || semantics.dialog.labelledby,
              "Modal must have accessible naming source",
            );
          }
          const axeResult = await page.evaluate(async () =>
            axe.run(document, {
              resultTypes: [
                "violations",
                "incomplete",
                "passes",
                "inapplicable",
              ],
            }),
          );
          // Chromium computed accessibility tree provides names, including referenced/wrapping labels.
          const cdp = await page.context().newCDPSession(page);
          const ax = await cdp.send("Accessibility.getFullAXTree");
          await cdp.detach();
          const view = {
            state,
            populationSteps,
            width,
            mode,
            tab,
            semantics,
            accessibilityTree: ax.nodes,
            axe: axeResult,
          };
          report.views.push(view);
          await writeFile(
            join(scratch, "report.json"),
            JSON.stringify(report, null, 2),
          );
          await writeFile(
            join(scratch, "progress.md"),
            `# Accessibility audit\n\nCompleted ${report.views.length}/64 views. Latest: ${width}px ${state} ${mode} ${tab}; ${axeResult.violations.length} violation rules. Full details: report.json.\n`,
          );
          console.log(
            JSON.stringify({
              width,
              state,
              mode,
              tab,
              rules: axeResult.violations.map((v) => ({
                id: v.id,
                count: v.nodes.length,
                targets: v.nodes.map((n) => n.target),
              })),
            }),
          );
        }
        if (mode === "expanded") {
          await page.keyboard.press("Escape");
          assert.equal(
            await page.locator("#inspection-dialog").evaluate((e) => e.open),
            false,
          );
        }
      }
    }
    await page.close();
  }
  const wcag = report.views.flatMap((v) =>
    v.axe.violations
      .filter((r) =>
        r.tags.some((t) =>
          ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"].includes(t),
        ),
      )
      .map((r) => ({
        view: `${v.width}/${v.state}/${v.mode}/${v.tab}`,
        id: r.id,
        count: r.nodes.length,
        targets: r.nodes.map((n) => n.target),
      })),
  );
  report.wcagViolations = wcag;
  await writeFile(
    join(scratch, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    join(scratch, "progress.md"),
    `# Accessibility audit complete\n\n64 views; ${wcag.length} WCAG rule/view violations and ${wcag.reduce((n, r) => n + r.count, 0)} node occurrences. See report.json for exact selectors, contrast findings, computed accessibility trees, live regions, headings and landmarks. Automated evidence only; no screen-reader certification.\n`,
  );
  console.log(
    JSON.stringify({
      scratch,
      views: report.views.length,
      wcagRuleViews: wcag.length,
      wcagNodeOccurrences: wcag.reduce((n, r) => n + r.count, 0),
      errors: report.errors,
    }),
  );
  assert.deepEqual(report.errors, []);
  assert.equal(
    wcag.length,
    0,
    "WCAG A/AA violations remain; see " + scratch + "/report.json",
  );
} finally {
  await browser.close();
}
