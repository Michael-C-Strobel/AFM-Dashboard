/** Optional instrument workspace QA. Start the local server; no dependencies are installed here. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
async function visiblePanel(name) {
  for (const other of [
    "measurements",
    "acquisition",
    "batch",
    "assistant",
    "features",
    "texture",
    "registration",
  ]) {
    assert.equal(
      await page.locator("#panel-" + other).isVisible(),
      other === name,
    );
    assert.equal(
      await page.locator("#tab-" + other).getAttribute("aria-selected"),
      String(other === name),
    );
    assert.equal(
      await page.locator("#tab-" + other).getAttribute("tabindex"),
      other === name ? "0" : "-1",
    );
  }
}
async function maps() {
  return page
    .locator("#raw, #result")
    .evaluateAll((nodes) => nodes.map((node) => node.toDataURL()));
}
try {
  await page.goto(process.env.AFM_BASE_URL || "http://127.0.0.1:4174/web/");
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
    {},
    { timeout: 60000 },
  );
  assert.equal(await page.locator("#status.error").count(), 0);
  await visiblePanel("measurements");
  const before = await maps();
  const calibration = await page.locator("#metadata").textContent();
  await page.locator("#tab-measurements").focus();
  await page.keyboard.press("ArrowRight");
  await visiblePanel("acquisition");
  assert.equal(
    await page
      .locator("#tab-acquisition")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("End");
  await visiblePanel("registration");
  await page.keyboard.press("ArrowRight");
  await visiblePanel("measurements");
  await page.keyboard.press("ArrowLeft");
  await visiblePanel("registration");
  await page.keyboard.press("Home");
  await visiblePanel("measurements");
  assert.deepEqual(
    await maps(),
    before,
    "Changing inspection panels cannot redraw or mutate either map",
  );
  assert.equal(await page.locator("#metadata").textContent(), calibration);
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .locator("#panel-measurements")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const raw = await page.locator("#raw").boundingBox(),
    result = await page.locator("#result").boundingBox();
  assert.ok(
    raw.width > 400 && raw.height > 300,
    "Desktop scan viewport remains prominent",
  );
  assert.equal(raw.y, result.y, "Desktop maps share a row");
  await page.locator("#preset").click();
  await page.waitForFunction(
    () => !document.querySelector("#download").disabled,
  );
  await page.locator("main").evaluate((node) => (node.scrollTop = 0));
  await page.locator("aside").evaluate((node) => (node.scrollTop = 0));
  await page.screenshot({ path: "/tmp/afm-instrument-desktop.png" });
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForFunction(() => document.querySelector("#raw").width > 0);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No horizontal overflow at " + width,
    );
    for (const id of ["raw", "result"]) {
      const box = await page.locator("#" + id).boundingBox();
      assert.ok(box.width > 120 && box.height >= 230);
      assert.ok(
        await page
          .locator("#" + id)
          .evaluate(
            (node) =>
              node.width === Math.round(node.clientWidth * devicePixelRatio),
          ),
      );
    }
  }
  assert.equal(await page.locator("#data-inspector").isVisible(), false);
  await page.locator("#toggle-inspector").click();
  assert.equal(await page.locator("#data-inspector").isVisible(), true);
  assert.equal(
    await page.locator("#toggle-inspector").getAttribute("aria-expanded"),
    "true",
  );
  await page.locator("#toggle-inspector").click();
  assert.equal(await page.locator("#data-inspector").isVisible(), false);
  await page.locator("#tab-batch").click();
  await visiblePanel("batch");
  await page.locator("#tab-acquisition").click();
  await visiblePanel("acquisition");
  await page.locator("#tab-measurements").click();
  await visiblePanel("measurements");
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/afm-instrument-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        panels: 7,
        keyboard: "arrows, Home, End, Tab",
        widths: [1440, 1024, 768, 390],
        screenshots: [
          "/tmp/afm-instrument-desktop.png",
          "/tmp/afm-instrument-mobile.png",
        ],
        console_errors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
