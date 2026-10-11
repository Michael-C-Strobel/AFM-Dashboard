import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceReport } from "../web/evidence-report.js";
import { createToolSession, canonicalJSON } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { analyze } from "../web/service.js";
import { sha256 } from "../web/engine.js";

const hash = "a".repeat(64),
  engine = "e".repeat(64);
const encode = new TextEncoder();
const canonical = (value) => canonicalJSON(value, new Set(), 0, 128);
function fixture(unit = "m") {
  const channel = {
    id: "0",
    title: "Height",
    width: 2,
    height: 2,
    xreal: 2,
    yreal: 2,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: unit,
    data: new Float64Array([0, 1, 2, 3]),
    mask: null,
    metadata: { "Import / support": "unverified instrument configuration" },
    log: [],
    warnings: ["Fixture configuration is not certified."],
    selections: {},
  };
  return {
    channels: { 0: channel },
    sha256: hash,
    unsupported: [],
    warnings: ["Fixture warning."],
  };
}
const analysisCall = () => ({
  name: "analyze_surface",
  arguments: {
    file: "source.gwy",
    source_sha256: hash,
    channel: "0",
    operations: [],
  },
});
const plan = () => ({
  schema_version: 1,
  title: "Surface evidence",
  steps: [
    {
      id: "measure",
      rationale: "Measure selected surface.",
      call: analysisCall(),
    },
  ],
});
async function make({
  raw = plan(),
  unit = "m",
  fail = false,
  shouldCancel = () => false,
  onUpdate = () => {},
} = {}) {
  let clock = 0;
  const source = fixture(unit);
  let session;
  session = createToolSession({
    now: () => `time-${clock++}`,
    invoke: async (name, args) => {
      if (fail) throw new Error("Analysis unavailable <script>");
      if (name === "list_sources") return { sources: [] };
      let result;
      if (name === "analyze_surface")
        result = await analyze(args, source, null, engine);
      else if (name === "replay_recipe") {
        const previous = session.artifact(args.recipe_artifact).content.result;
        result = structuredClone(previous);
        result.replay_verified = true;
        return result;
      } else throw new Error("Unexpected tool");
      return Object.fromEntries(
        [
          "recipe",
          "channel",
          "statistics",
          "history",
          "quality",
          "step",
          "profile",
          "warnings",
          "comparison",
        ].map((k) => [k, result[k]]),
      );
    },
  });
  const manifest = await runPlan(raw, {
    execute: session.execute,
    shouldCancel,
    onUpdate,
  });
  return { manifest, journal: session.journal() };
}
async function resignArtifact(input, index = 0) {
  const envelope = input.manifest.steps[index].result;
  envelope.artifact.sha256 = await sha256(
    encode.encode(canonical(envelope.artifact.content)),
  );
  envelope.artifact.id = "artifact:" + envelope.artifact.sha256;
  envelope.record.artifact_id = envelope.artifact.id;
  const sequence = envelope.record.sequence;
  input.journal.records[sequence - 1] = structuredClone(envelope.record);
  let previous = null;
  for (const r of input.journal.records) {
    r.previous_sha256 = previous;
    delete r.sha256;
    r.sha256 = await sha256(encode.encode(canonical(r)));
    previous = r.sha256;
  }
  input.journal.head_sha256 = previous;
  for (const step of input.manifest.steps)
    if (step.result)
      step.result.record = structuredClone(
        input.journal.records[step.result.record.sequence - 1],
      );
}

test("real session and plan produce eight traceable numeric claims and deterministic safe Markdown", async () => {
  const raw = plan();
  raw.title = "<img src=x> [link](https://evil)";
  raw.steps[0].rationale = "Use **exact** values | safely";
  const input = await make({ raw }),
    before = structuredClone(input);
  const report = await createEvidenceReport(input);
  assert.deepEqual(report, await createEvidenceReport(input));
  assert.deepEqual(input, before);
  assert.equal(report.claims.length, 8);
  assert.deepEqual(
    report.claims.map((c) => c.metric),
    ["sa", "sq", "mean", "min", "max", "valid_count", "excluded_count", "area"],
  );
  assert.equal(report.claims.find((c) => c.metric === "mean").value, 1.5);
  assert.equal(
    report.claims.find((c) => c.metric === "valid_count").unit,
    "pixels",
  );
  assert.equal(report.claims.find((c) => c.metric === "area").unit, "(m)²");
  assert.ok(
    report.claims.every(
      (c) =>
        c.source_sha256 === hash &&
        c.channel === "0" &&
        c.artifact_id === input.manifest.steps[0].result.artifact.id,
    ),
  );
  assert.match(report.markdown, /not a signature or calibration certification/);
  assert.match(report.markdown, /#artifact-[a-f0-9]{64}/);
  assert.match(report.markdown, /Operations:/);
  assert.match(report.markdown, /Selection\/ROI:/);
  assert.doesNotMatch(report.markdown, /<img|\[link\]\(https:/);
  assert.match(report.markdown, /&lt;img/);
  assert.ok(report.warnings.some((w) => /not certify/.test(w)));
  assert.equal(
    report.warnings.filter((w) => w === "Fixture warning.").length,
    1,
  );
});
test("unknown vertical units remain null and are explicitly warned", async () => {
  const r = await createEvidenceReport(await make({ unit: null }));
  assert.equal(r.claims.find((c) => c.metric === "sq").unit, null);
  assert.ok(r.warnings.some((w) => /vertical units are unknown/.test(w)));
});
test("artifact metric changes, missing artifacts and journal tampering fail closed", async () => {
  const base = await make();
  for (const change of [
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.statistics.sa = 999),
    (x) => (x.manifest.steps[0].result.artifact = null),
    (x) => (x.journal.records[0].finished_at = "tampered"),
    (x) => (x.journal.records[0].previous_sha256 = "0".repeat(64)),
    (x) => (x.journal.head_sha256 = "0".repeat(64)),
    (x) => (x.journal.records[0].sequence = 2),
    (x) =>
      (x.manifest.steps[0].result.record.call.arguments.file = "other.gwy"),
    (x) => (x.manifest.plan_sha256 = "0".repeat(64)),
    (x) => (x.manifest.steps[0].id = "other"),
    (x) => (x.manifest.steps[0].resolved_call.arguments.channel = "1"),
  ]) {
    const x = structuredClone(base);
    change(x);
    await assert.rejects(createEvidenceReport(x));
  }
});
test("consistent content hashes still require source, geometry and unit agreement", async () => {
  const base = await make();
  for (const change of [
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.recipe.source.sha256 =
        "b".repeat(64)),
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.recipe.source.geometry.z_unit =
        "V"),
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.statistics.z_unit =
        "V"),
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.channel.xreal = 22),
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.statistics.area = 200),
    (x) =>
      (x.manifest.steps[0].result.artifact.content.result.recipe.operations = [
        { name: "mean", params: {} },
      ]),
  ]) {
    const x = structuredClone(base);
    change(x);
    await resignArtifact(x);
    await assert.rejects(createEvidenceReport(x));
  }
});
test("failed plan exposes errors and no numeric claims; future steps remain not run", async () => {
  const raw = plan();
  raw.steps.push({
    id: "later",
    call: { name: "list_sources", arguments: {} },
  });
  const input = await make({ raw, fail: true });
  assert.equal(input.manifest.status, "failed");
  const r = await createEvidenceReport(input);
  assert.equal(r.claims.length, 0);
  assert.match(r.markdown, /failed/);
  assert.match(r.markdown, /not_run/);
  assert.doesNotMatch(r.markdown, /<script>/);
  const bad = structuredClone(input);
  bad.manifest.steps[0].result.record.error = "edited";
  await assert.rejects(createEvidenceReport(bad));
});
test("canceled and pending manifests contain only already completed verified claims", async () => {
  const raw = plan();
  raw.steps.push({
    id: "later",
    call: { name: "list_sources", arguments: {} },
  });
  let cancel = false;
  const input = await make({
    raw,
    shouldCancel: () => cancel,
    onUpdate: (m) => {
      if (m.steps[0].status === "complete") cancel = true;
    },
  });
  const r = await createEvidenceReport(input);
  assert.equal(input.manifest.status, "canceled");
  assert.equal(r.claims.length, 8);
  assert.match(r.markdown, /canceled/);
  assert.match(r.markdown, /later: \*\*not_run/);
  const canceled = await make({ raw, shouldCancel: () => true });
  assert.equal((await createEvidenceReport(canceled)).claims.length, 0);
  let initial;
  await make({
    raw,
    onUpdate: (m) => {
      if (!initial) initial = m;
    },
  });
  assert.equal(
    (
      await createEvidenceReport({
        manifest: initial,
        journal: {
          schema_version: 1,
          tool_version: "1.0.0",
          records: [],
          head_sha256: null,
        },
      })
    ).claims.length,
    0,
  );
});
test("callback failures without tool records remain visible without fabricated claims", async () => {
  const manifest = await runPlan(plan(), {
    execute: async () => {
      throw new Error("Call capacity exceeded");
    },
  });
  const r = await createEvidenceReport({
    manifest,
    journal: {
      schema_version: 1,
      tool_version: "1.0.0",
      records: [],
      head_sha256: null,
    },
  });
  assert.equal(r.claims.length, 0);
  assert.match(r.markdown, /Call capacity exceeded/);
});
test("step artifact references bind replay to preceding verified artifact", async () => {
  const raw = plan();
  raw.steps.push({
    id: "replay",
    call: {
      name: "replay_recipe",
      arguments: {
        file: "source.gwy",
        source_sha256: hash,
        recipe_artifact: "$step:measure",
      },
    },
  });
  const input = await make({ raw });
  const r = await createEvidenceReport(input);
  assert.equal(r.claims.length, 16);
  assert.equal(r.claims.filter((c) => c.step_id === "replay").length, 8);
  input.manifest.steps[1].resolved_call.arguments.recipe_artifact =
    "artifact:" + "0".repeat(64);
  await assert.rejects(createEvidenceReport(input), /Resolved call/);
});
test("non-analysis artifacts never become numeric scientific claims", async () => {
  const input = await make({
    raw: {
      schema_version: 1,
      title: "Listing",
      steps: [{ id: "list", call: { name: "list_sources", arguments: {} } }],
    },
  });
  const r = await createEvidenceReport(input);
  assert.equal(r.claims.length, 0);
  assert.match(r.markdown, /No numeric analysis claims/);
});

test("rehashed replay recipes must exactly match the preceding verified recipe", async () => {
  const raw = plan();
  raw.steps.push({
    id: "replay",
    call: {
      name: "replay_recipe",
      arguments: {
        file: "source.gwy",
        source_sha256: hash,
        recipe_artifact: "$step:measure",
      },
    },
  });
  const base = await make({ raw });
  for (const change of [
    (r) => {
      r.recipe.source.channel = "1";
      r.channel.id = "1";
    },
    (r) => {
      r.recipe.source.title = "Other surface";
      r.channel.title = "Other surface";
    },
    (r) => {
      r.recipe.source.geometry.z_unit = "V";
      r.recipe.output.geometry.z_unit = "V";
      r.channel.z_unit = "V";
      r.statistics.z_unit = "V";
    },
    (r) => {
      r.recipe.operations = [{ name: "mean", params: {} }];
    },
    (r) => {
      r.recipe.selection = { roi: [0, 0, 1, 1], mask: "ignore" };
    },
    (r) => {
      r.recipe.output.sha256 = "b".repeat(64);
    },
    (r) => {
      r.recipe.profile = [
        [0, 0],
        [1, 1],
      ];
    },
  ]) {
    const input = structuredClone(base);
    change(input.manifest.steps[1].result.artifact.content.result);
    await resignArtifact(input, 1);
    await assert.rejects(createEvidenceReport(input), /Replay recipe differs/);
  }
});

test("literal replay references require the referenced artifact evidence in the manifest", async () => {
  const raw = plan();
  raw.steps.push({
    id: "replay",
    call: {
      name: "replay_recipe",
      arguments: {
        file: "source.gwy",
        source_sha256: hash,
        recipe_artifact: "$step:measure",
      },
    },
  });
  const input = await make({ raw });
  input.manifest.plan.steps[1].call.arguments.recipe_artifact =
    input.manifest.steps[0].result.artifact.id;
  input.manifest.plan_sha256 = await sha256(
    encode.encode(JSON.stringify(input.manifest.plan)),
  );
  assert.equal((await createEvidenceReport(input)).claims.length, 16);
  // The journal still proves both records, but omitting the first artifact leaves
  // no recipe content against which the replay can be checked.
  input.manifest.plan.steps.shift();
  input.manifest.steps.shift();
  input.manifest.plan_sha256 = await sha256(
    encode.encode(JSON.stringify(input.manifest.plan)),
  );
  await assert.rejects(
    createEvidenceReport(input),
    /lacks a preceding verified analysis artifact/,
  );
});
