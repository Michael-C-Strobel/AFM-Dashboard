import test from "node:test";
import assert from "node:assert/strict";
import { createModelEvidence } from "../web/model-evidence.js";
import { createEvidenceReport } from "../web/evidence-report.js";
import { createToolSession } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { analyze, replay } from "../web/service.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64);
const encode = new TextEncoder();

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
        result = await replay(previous.recipe, source, null, engine);
        // Ensure the test exercises a fresh execution timestamp even on a fast clock.
        result.recipe.created_at = "2030-01-01T00:00:00.000Z";
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
          "replay_verified",
        ].map((k) => [k, result[k] ?? null]),
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

const sources = () => [
  { file: "source.gwy", source_sha256: hash, channel: "0", title: "Height" },
];
const bundle = async (options) => ({
  ...(await make(options)),
  step_ids: ["measure"],
});
test("projects exact verified claims with attribution and recorded warnings only", async () => {
  const input = await bundle(),
    original = structuredClone(input),
    report = await createEvidenceReport(input),
    e = await createModelEvidence(input, sources());
  assert.deepEqual(Object.keys(e), [
    "schema_version",
    "plan_sha256",
    "journal_head_sha256",
    "run_status",
    "claims",
    "warnings",
  ]);
  assert.equal(e.run_status, "complete");
  assert.equal(e.claims.length, 8);
  assert.deepEqual(e.warnings, report.warnings);
  for (let i = 0; i < e.claims.length; i++) {
    const { file, claim_id, ...claim } = e.claims[i];
    assert.deepEqual(claim, report.claims[i]);
    assert.equal(file, "source.gwy");
    assert.equal(claim_id, `${e.plan_sha256}:measure:${claim.metric}`);
  }
  assert.deepEqual(input, original);
  assert.ok(e.warnings.some((w) => w.includes("Fixture warning")));
  assert.ok(!Object.hasOwn(e, "markdown"));
  assert.ok(!Object.hasOwn(e, "manifest"));
  assert.ok(!Object.hasOwn(e, "recipe"));
});
test("unknown units and replay claims preserve exact verified values", async () => {
  const p = plan();
  p.steps.push({
    id: "again",
    call: {
      name: "replay_recipe",
      arguments: {
        file: "source.gwy",
        source_sha256: hash,
        recipe_artifact: "$step:measure",
      },
    },
  });
  const input = await bundle({ raw: p, unit: null });
  input.step_ids = ["again", "measure"];
  const e = await createModelEvidence(input, sources());
  assert.equal(e.claims.length, 16);
  assert.equal(e.claims[0].step_id, "again");
  assert.equal(e.claims.find((c) => c.metric === "sa").unit, null);
});
test("bundle tamper unknown steps no-claim outcomes and unsent tuple fail closed", async () => {
  const good = await bundle();
  for (const change of [
    (b) => (b.journal.head_sha256 = "f".repeat(64)),
    (b) =>
      (b.manifest.steps[0].result.artifact.content.result.statistics.sa = 99),
    (b) => (b.step_ids = ["unknown"]),
    (b) => (b.step_ids = ["measure", "measure"]),
    (b) => (b.step_ids = []),
    (b) => (b.step_ids = Array.from({ length: 5 }, (_, i) => "s" + i)),
    (b) => (b.extra = true),
    (b) => delete b.journal,
  ]) {
    const b = structuredClone(good);
    change(b);
    await assert.rejects(createModelEvidence(b, sources()));
  }
  for (const selection of [
    [{ ...sources()[0], file: "other.gwy" }],
    [{ ...sources()[0], channel: "1" }],
    [{ ...sources()[0], source_sha256: "b".repeat(64) }],
    [
      { ...sources()[0], file: "other.gwy" },
      { ...sources()[0], source_sha256: "b".repeat(64) },
    ],
  ])
    await assert.rejects(createModelEvidence(good, selection), /source tuples/);
  await assert.rejects(
    createModelEvidence(await bundle({ fail: true }), sources()),
    /no verified surface claims/,
  );
  const p = plan();
  p.steps[0].call = { name: "list_sources", arguments: {} };
  await assert.rejects(
    createModelEvidence(await bundle({ raw: p }), sources()),
    /no verified surface claims/,
  );
});
test("defensive snapshots reject getters and isolate asynchronous caller mutation", async () => {
  const input = await bundle(),
    selected = sources(),
    expected = await createModelEvidence(input, selected),
    pending = createModelEvidence(input, selected);
  input.step_ids[0] = "unknown";
  input.manifest.steps[0].result.artifact.content.result.statistics.sa = 99;
  selected[0].file = "other.gwy";
  assert.deepEqual(await pending, expected);
  let invoked = false;
  const bad = {};
  Object.defineProperty(bad, "manifest", {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  });
  await assert.rejects(createModelEvidence(bad, sources()));
  const getterSource = sources();
  Object.defineProperty(getterSource[0], "file", {
    enumerable: true,
    get() {
      invoked = true;
      return "source.gwy";
    },
  });
  await assert.rejects(createModelEvidence(await bundle(), getterSource));
  assert.equal(invoked, false);
  for (const badSources of [
    null,
    [],
    [{ ...sources()[0], source_sha256: NaN }],
    new Map(),
  ])
    await assert.rejects(createModelEvidence(await bundle(), badSources));
});
test("oversized verified warning evidence rejects rather than truncating", async () => {
  const source = fixture();
  source.warnings = ["Large warning " + "x".repeat(66000)];
  const session = createToolSession({
    invoke: async (name, args) => {
      const r = await analyze(args, source, null, engine);
      return {
        recipe: r.recipe,
        channel: r.channel,
        statistics: r.statistics,
        history: r.history,
        quality: r.quality,
        warnings: r.warnings,
        step: r.step,
        profile: r.profile,
        comparison: r.comparison,
      };
    },
  });
  const manifest = await runPlan(plan(), { execute: session.execute });
  assert.equal(manifest.status, "complete");
  await assert.rejects(
    createModelEvidence(
      { manifest, journal: session.journal(), step_ids: ["measure"] },
      sources(),
    ),
    /64 KiB/,
  );
});

async function contextualBundle({ reference = false, failLater = false } = {}) {
  const source = fixture(),
    raw = plan();
  if (reference)
    raw.steps[0].call.arguments.reference = {
      file: "reference.gwy",
      source_sha256: hash,
      channel: "0",
    };
  else
    raw.steps.push({
      id: "unselected",
      call: {
        ...analysisCall(),
        arguments: {
          ...analysisCall().arguments,
          file: "private-unselected.gwy",
        },
      },
    });
  const session = createToolSession({
    invoke: async (name, args) => {
      if (args.file === "private-unselected.gwy" && failLater)
        throw new Error("UNSELECTED_FAILURE_SECRET");
      const local = structuredClone(source);
      if (args.file === "private-unselected.gwy")
        local.warnings = ["UNSELECTED_WARNING_SECRET"];
      const r = await analyze(
        args,
        local,
        args.reference ? source : null,
        engine,
      );
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
        ].map((k) => [k, r[k]]),
      );
    },
  });
  const manifest = await runPlan(raw, { execute: session.execute });
  return { manifest, journal: session.journal(), step_ids: ["measure"] };
}
test("unselected warnings and failure text never enter model evidence", async () => {
  for (const failLater of [false, true]) {
    const input = await contextualBundle({ failLater }),
      report = await createEvidenceReport(input),
      e = await createModelEvidence(input, sources());
    assert.ok(report.warnings.some((w) => w.includes("UNSELECTED_")));
    assert.ok(!JSON.stringify(e).includes("UNSELECTED_"));
    assert.ok(!JSON.stringify(e).includes("private-unselected.gwy"));
    assert.ok(
      e.warnings.some((w) =>
        w.includes(
          "Imported support status: unverified instrument configuration",
        ),
      ),
    );
    assert.ok(
      e.warnings.every(
        (w) =>
          report.warnings.includes(w) ||
          w ===
            "The recorded run is incomplete; only explicitly selected verified surface claims are included.",
      ),
    );
    assert.equal(
      e.warnings.some((w) => w.includes("run is incomplete")),
      failLater,
    );
  }
});
test("a selected result reference also requires a transmitted source tuple", async () => {
  const input = await contextualBundle({ reference: true });
  await assert.rejects(
    createModelEvidence(input, sources()),
    /reference.*source tuples/,
  );
  const selected = [
    ...sources(),
    { file: "reference.gwy", source_sha256: hash, channel: "0" },
  ];
  assert.equal((await createModelEvidence(input, selected)).claims.length, 8);
});

test("four selected surface steps yield exactly32 claims without truncation", async () => {
  const raw = plan();
  raw.steps = Array.from({ length: 4 }, (_, i) => ({
    id: "step" + i,
    call: analysisCall(),
  }));
  const input = await bundle({ raw });
  input.step_ids = raw.steps.map((s) => s.id);
  const e = await createModelEvidence(input, sources());
  assert.equal(e.claims.length, 32);
  assert.equal(new Set(e.claims.map((c) => c.claim_id)).size, 32);
  assert.ok(new TextEncoder().encode(JSON.stringify(e)).length <= 65536);
});
