import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { workflowSops, sopPrompt } from "../web/workflow-sops.js";
const sections = [
  "prerequisites",
  "procedure",
  "qualityChecks",
  "outputs",
  "limitations",
];
test("pilot SOP identifiers, version and nested immutable guidance remain explicit", () => {
  assert.deepEqual(
    workflowSops.map((s) => s.id),
    ["height-roughness", "chemist-reference"],
  );
  assert.ok(Object.isFrozen(workflowSops));
  for (const sop of workflowSops) {
    assert.equal(sop.version, "0.1.0");
    assert.equal(sop.status, "pilot");
    assert.ok(Object.isFrozen(sop));
    assert.deepEqual(Object.keys(sop), [
      "id",
      "version",
      "status",
      "title",
      ...sections,
    ]);
    assert.throws(() => {
      sop.version = "changed";
    }, TypeError);
    for (const key of sections) {
      assert.ok(Object.isFrozen(sop[key]));
      assert.ok(sop[key].length > 0);
      assert.ok(sop[key].every((s) => typeof s === "string" && s.length > 30));
      assert.throws(() => sop[key].push("changed"), TypeError);
    }
  }
});
test("prompts are deterministic, bounded and preserve every guidance item with pilot attribution", () => {
  for (const sop of workflowSops) {
    const prompt = sopPrompt(sop.id);
    assert.equal(prompt, sopPrompt(sop.id));
    assert.ok(prompt.length < 4000);
    assert.ok(
      prompt.startsWith(
        `SOP ${sop.id} / version ${sop.version} / status pilot`,
      ),
    );
    assert.ok(prompt.includes(sop.title));
    for (const key of sections)
      for (const item of sop[key]) assert.ok(prompt.includes(item));
  }
  for (const id of ["unknown", "", null, undefined, {}, "HEIGHT-ROUGHNESS"])
    assert.throws(() => sopPrompt(id), /Unknown workflow SOP/);
});
test("chemist SOP follows documented sequence and requires explicit points without claiming universality", async () => {
  const reference = JSON.parse(
    await readFile(
      new URL("../docs/reference_pair.json", import.meta.url),
      "utf8",
    ),
  );
  const text = sopPrompt("chemist-reference");
  assert.ok(text.includes(reference.raw));
  assert.ok(text.includes(reference.worked));
  assert.match(reference.channels[0].worked_log[0], /GwyToolLevel3/);
  assert.match(reference.channels[0].worked_log[1], /fix_zero/);
  assert.match(text, /three-point leveling, then minimum-zero/);
  assert.match(text, /explicit user-reviewed fit points/);
  assert.match(text, /not universal scientific ground truth/);
  assert.match(text, /do not infer coordinates/);
});
test("documentation covers every stable pilot and audit responsibilities", async () => {
  const docs = await readFile(
    new URL("../docs/workflow-sops.md", import.meta.url),
    "utf8",
  );
  for (const s of workflowSops) {
    assert.ok(docs.includes("`" + s.id + "`"));
    assert.ok(docs.includes("`" + s.version + "`"));
  }
  assert.match(docs, /status `pilot`/);
  assert.match(docs, /goal audit/);
  assert.match(docs, /deviations/);
  assert.match(docs, /caller is responsible/);
  const roughness = sopPrompt("height-roughness");
  assert.match(roughness, /original values as a baseline/);
  assert.match(roughness, /Strictly replay/);
  assert.match(roughness, /Do not invent acceptance thresholds/);
  assert.match(roughness, /not independent samples/);
});
