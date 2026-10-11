import test from "node:test";
import assert from "node:assert/strict";
import { createModelObservations } from "../web/model-observations.js";
import { createToolSession, canonicalJSON } from "../web/tool-session.js";
import { runPlan } from "../web/tool-plans.js";
import { analyze } from "../web/service.js";
import { qualityReport } from "../web/quality.js";
import { segmentRecipe } from "../web/segmentation-service.js";
import { textureRecipe } from "../web/texture-service.js";
import { sensitivityReport } from "../web/sensitivity-service.js";
import { sha256 } from "../web/engine.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64),
  canon = (v) => canonicalJSON(v, new Set(), 0, 128),
  digest = (v) => sha256(new TextEncoder().encode(canon(v)));
const sources = () => [
  {
    file: "sample.gwy",
    source_sha256: hash,
    channel: "0",
    warnings: ["Selected source caveat"],
  },
];
const code = (names) => ({
  sha256: engine,
  files: names.map((name) => ({ name, sha256: engine })),
});
async function make({
  reference = false,
  unknown = false,
  unrelated = false,
} = {}) {
  const channel = {
    id: "0",
    title: "Height",
    width: 4,
    height: 4,
    xreal: 4e-6,
    yreal: 4e-6,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
    data: Float64Array.from(
      { length: 16 },
      (_, i) => ((i % 4) + Math.floor(i / 4) * 2) * 1e-9,
    ),
    mask: null,
    metadata: {},
    log: [],
    warnings: ["Imported channel caveat"],
    selections: {},
  };
  const source = {
    sha256: hash,
    channels: {
      0: channel,
      1: {
        ...channel,
        id: "1",
        title: "Retrace",
        warnings: ["Reference channel caveat"],
      },
    },
    warnings: ["Input caveat"],
    unsupported: [],
  };
  const args = { file: "sample.gwy", source_sha256: hash, channel: "0" },
    derived = {
      file: "sample.gwy",
      source_sha256: hash,
      recipe_artifact: "$step:base",
    };
  const raw = {
    schema_version: 1,
    title: "Diagnostic observations",
    steps: [
      {
        id: "base",
        call: {
          name: "analyze_surface",
          arguments: {
            ...args,
            operations: [],
            ...(reference
              ? {
                  reference: {
                    file: "sample.gwy",
                    source_sha256: hash,
                    channel: "1",
                  },
                }
              : {}),
          },
        },
      },
      {
        id: "quality",
        call: {
          name: "check_quality",
          arguments: {
            ...args,
            ...(reference ? { reference_channel: "1" } : {}),
          },
        },
      },
      {
        id: "segments",
        call: {
          name: "segment_surface",
          arguments: { ...derived, parameters: { threshold: 4e-9 } },
        },
      },
      {
        id: "texture",
        call: {
          name: "measure_texture",
          arguments: { ...derived, parameters: {} },
        },
      },
      {
        id: "sensitivity",
        call: {
          name: "analyze_sensitivity",
          arguments: {
            ...derived,
            variants: [
              {
                id: "mean",
                label: "Mean removed",
                operations: [{ name: "mean" }],
                selection: {},
              },
              {
                id: "empty",
                label: "Empty ROI",
                operations: [],
                selection: { roi: [100, 100, 101, 101] },
              },
            ],
            assumptions: {
              calibration_note: "Not measured",
              model_note: "Alternatives",
            },
          },
        },
      },
      ...(unrelated
        ? [
            {
              id: "unrelated",
              call: { name: "check_quality", arguments: { ...args } },
            },
          ]
        : []),
    ],
  };
  let session,
    qualityCalls = 0;
  session = createToolSession({
    invoke: async (name, a) => {
      let result;
      if (name === "analyze_surface") {
        const r = await analyze(
          {
            ...a,
            reference: a.reference
              ? { file: a.reference.file, channel: a.reference.channel }
              : null,
          },
          source,
          reference ? source : null,
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
            "comparison",
            "warnings",
          ].map((k) => [k, r[k]]),
        );
      }
      if (name === "check_quality") {
        qualityCalls++;
        const report = qualityReport(
          channel,
          { selection: a.selection, boundary_sigma: a.boundary_sigma },
          a.reference_channel ? source.channels[1] : null,
        );
        result = {
          schema_version: 1,
          input: {
            file: a.file,
            sha256: hash,
            channel: "0",
            support: {
              status: "unverified",
              message: "Unverified acquisition",
              format: "GWYP",
              configuration: "synthetic",
              private: "DO_NOT_SEND_SUPPORT",
            },
            warnings: ["Input warning"],
            reference_channel: a.reference_channel,
            reference_warnings: reference ? ["Reference warning"] : [],
          },
          parameters: report.parameters,
          report,
          warnings:
            qualityCalls > 1 ? ["UNRELATED_WARNING"] : ["Quality caveat"],
        };
      } else {
        const recipe = session.artifact(a.recipe_artifact).content.result
          .recipe;
        if (name === "segment_surface") {
          const { labels, ...r } = await segmentRecipe(
            { recipe, parameters: a.parameters },
            source,
            reference ? source : null,
            engine,
            code(["segmentation.js", "segmentation-service.js", "engine.js"]),
          );
          result = r;
        }
        if (name === "measure_texture")
          result = (
            await textureRecipe(
              { recipe, parameters: a.parameters },
              source,
              reference ? source : null,
              engine,
              code(["fft.js", "texture.js", "texture-service.js", "engine.js"]),
            )
          ).report;
        if (name === "analyze_sensitivity")
          result = await sensitivityReport(
            {
              baseline_recipe: recipe,
              variants: a.variants,
              assumptions: a.assumptions,
            },
            source,
            reference ? source : null,
            engine,
            code(["sensitivity.js", "sensitivity-service.js", "engine.js"]),
          );
      }
      if (unknown)
        result.private_payload = {
          rasters: [1, 2, 3],
          marker: "DO_NOT_SEND_UNKNOWN",
        };
      return result;
    },
  });
  const manifest = await runPlan(raw, { execute: session.execute });
  assert.equal(manifest.status, "complete", JSON.stringify(manifest));
  return {
    manifest,
    journal: session.journal(),
    step_ids: ["quality", "segments", "texture", "sensitivity"],
  };
}
async function resign(input, index) {
  const step = input.manifest.steps[index],
    artifact = step.result.artifact;
  artifact.sha256 = await digest(artifact.content);
  artifact.id = "artifact:" + artifact.sha256;
  step.result.record.artifact_id = artifact.id;
  const journalRecord = input.journal.records.find(
    (r) => r.sequence === step.result.record.sequence,
  );
  journalRecord.artifact_id = artifact.id;
  let previous = null;
  for (const record of input.journal.records) {
    record.previous_sha256 = previous;
    delete record.sha256;
    record.sha256 = await digest(record);
    previous = record.sha256;
    const linked = input.manifest.steps.find(
      (s) => s.result?.record?.sequence === record.sequence,
    );
    if (linked) linked.result.record = structuredClone(record);
  }
  input.journal.head_sha256 = previous;
  return input;
}
test("all four production reports project bounded recorded summaries without bulk payloads", async () => {
  const input = await make({ unknown: true, unrelated: true }),
    saved = structuredClone(input),
    output = await createModelObservations(input, sources());
  assert.deepEqual(Object.keys(output), [
    "schema_version",
    "plan_sha256",
    "journal_head_sha256",
    "run_status",
    "observations",
    "warnings",
  ]);
  assert.equal(output.observations.length, 4);
  const [q, s, t, v] = output.observations;
  assert.equal(q.summary.counts.total, 16);
  assert.equal(q.summary.support.status, "unverified");
  assert.equal(
    q.summary.rows.candidate_count,
    input.manifest.steps[1].result.artifact.content.result.report.rows
      .candidates.length,
  );
  assert.equal(s.summary.counts.accepted_regions, 1);
  assert.equal(s.summary.counts.valid, 16);
  assert.equal(
    t.summary.psd.integral,
    input.manifest.steps[3].result.artifact.content.result.psd.integral,
  );
  assert.equal(t.summary.psd.integral_unit, t.summary.acf.unit);
  assert.equal(v.summary.status, "partial");
  assert.equal(v.summary.model_note, "Alternatives");
  assert.equal(v.summary.calibration_uncertainty.status, "not_evaluated");
  assert.equal(v.summary.summary.metrics[0].values[2].status, "failed");
  assert.equal(v.summary.summary.metrics[0].values[2].value, null);
  assert.match(v.summary.summary.metrics[0].values[2].reason, /failed/);
  for (const o of output.observations) {
    assert.equal(
      o.observation_id,
      `${output.plan_sha256}:${o.step_id}:${o.tool}`,
    );
    assert.deepEqual(o.source, {
      file: "sample.gwy",
      source_sha256: hash,
      channel: "0",
    });
    assert.ok(o.warnings.includes("Selected source caveat"));
  }
  const serialized = JSON.stringify(output);
  for (const marker of [
    "DO_NOT_SEND",
    "UNRELATED_WARNING",
    "input_recipe",
    "exclude_regions",
    '"overview"',
    '"cuts"',
    '"labels"',
    '"medians"',
    '"journal"',
  ])
    assert.ok(!serialized.includes(marker), marker);
  assert.deepEqual(input, saved);
});
test("selected references must match complete transmitted tuples", async () => {
  const input = await make({ reference: true });
  await assert.rejects(createModelObservations(input, sources()));
  const selected = [
    ...sources(),
    {
      file: "sample.gwy",
      source_sha256: hash,
      channel: "1",
      warnings: ["Selected reference caveat"],
    },
  ];
  const output = await createModelObservations(input, selected);
  assert.ok(output.warnings.includes("Reference warning"));
  assert.ok(output.warnings.includes("Selected reference caveat"));
  assert.ok(output.observations[0].summary.comparison);
  for (const selection of [
    [{ ...sources()[0], file: "other.gwy" }],
    [{ ...sources()[0], channel: "1" }],
    [{ ...sources()[0], source_sha256: "b".repeat(64) }],
  ])
    await assert.rejects(createModelObservations(await make(), selection));
});
test("tamper and independently rehashed source predecessor parameter and variant changes reject", async () => {
  const original = await make();
  const tampered = structuredClone(original);
  tampered.manifest.steps[1].result.artifact.content.result.report.counts.selected = 0;
  await assert.rejects(createModelObservations(tampered, sources()));
  for (const [index, change] of [
    [1, (r) => (r.input.sha256 = "b".repeat(64))],
    [1, (r) => (r.input.channel = "1")],
    [1, (r) => (r.input.reference_channel = "1")],
    [1, (r) => (r.parameters.boundary_sigma = 5)],
    [1, (r) => (r.report.units.z = "V")],
    [2, (r) => (r.input_recipe.created_at = "2030-01-01T00:00:00.000Z")],
    [2, (r) => (r.parameters.threshold = 1)],
    [2, (r) => (r.input_recipe.source.channel = "1")],
    [3, (r) => (r.parameters.window = "hann")],
    [3, (r) => (r.psd.integral = "invalid")],
    [4, (r) => (r.request.variants[0].label = "Changed")],
    [4, (r) => (r.variants[0].result.recipe.source.channel = "1")],
    [
      4,
      (r) =>
        (r.variants[0].result.recipe.reference = {
          file: "other.gwy",
          channel: "0",
          sha256: hash,
        }),
    ],
  ]) {
    const input = structuredClone(original);
    change(input.manifest.steps[index].result.artifact.content.result);
    await resign(input, index);
    await assert.rejects(
      createModelObservations(input, sources()),
      `index${index}`,
    );
  }
  const missing = structuredClone(original);
  missing.step_ids = ["base"];
  await assert.rejects(createModelObservations(missing, sources()));
});
test("snapshot isolation, accessors, step bounds and projected byte overflow reject safely", async () => {
  const input = await make(),
    selected = sources(),
    expected = await createModelObservations(input, selected),
    pending = createModelObservations(input, selected);
  input.step_ids[0] = "bad";
  selected[0].file = "bad";
  assert.deepEqual(await pending, expected);
  let called = false;
  const bad = {};
  Object.defineProperty(bad, "manifest", {
    enumerable: true,
    get() {
      called = true;
      return {};
    },
  });
  await assert.rejects(createModelObservations(bad, sources()));
  assert.equal(called, false);
  for (const ids of [
    [],
    ["quality", "quality"],
    ["unknown"],
    ["a\n"],
    Array.from({ length: 17 }, (_, i) => "s" + i),
  ])
    await assert.rejects(
      createModelObservations({ ...(await make()), step_ids: ids }, sources()),
    );
  await assert.rejects(
    createModelObservations(await make(), [
      { ...sources()[0], warnings: ["x".repeat(66000)] },
    ]),
    /64 KiB/,
  );
});
