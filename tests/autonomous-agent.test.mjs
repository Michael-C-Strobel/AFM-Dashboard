import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomousAgent } from "../web/autonomous-agent.js";
import { createToolSession } from "../web/tool-session.js";
import { validatePlan } from "../web/tool-plans.js";
import { createModelEvidence } from "../web/model-evidence.js";
import { analyze } from "../web/service.js";
import { sha256 } from "../web/engine.js";
const hash = "a".repeat(64),
  engine = "e".repeat(64);
const selected = [
  { file: "a.gwy", source_sha256: hash, channel: "0", title: "Height" },
];
const settings = () => ({
  endpoint: "https://example.com/v1/chat/completions",
  model: "test",
  goal: "Measure the surface, then compare mean removal.",
  sourceContexts: structuredClone(selected),
  maxRounds: 4,
  maxCalls: 24,
});
// Build calls without optional undefined properties: tools accept finite plain JSON only.
const proposedPlan = (ops = []) =>
  validatePlan({
    schema_version: 1,
    title: "Measure",
    steps: [
      {
        id: "measure",
        call: {
          name: "analyze_surface",
          arguments: {
            file: "a.gwy",
            source_sha256: hash,
            channel: "0",
            operations: ops,
          },
        },
      },
    ],
  });
async function proposal(p = proposedPlan()) {
  return {
    proposal: { kind: "plan", plan: p },
    audit: {
      status: "proposed",
      proposal_plan_sha256: await sha256(
        new TextEncoder().encode(JSON.stringify(p)),
      ),
    },
  };
}
function session() {
  const source = {
    sha256: hash,
    warnings: [],
    unsupported: [],
    channels: {
      0: {
        id: "0",
        title: "Height",
        width: 2,
        height: 2,
        xreal: 2,
        yreal: 2,
        xoff: 0,
        yoff: 0,
        xy_unit: "m",
        z_unit: "m",
        data: Float64Array.of(0, 1, 2, 3),
        mask: null,
        metadata: {},
        warnings: [],
        log: [],
        selections: {},
      },
    },
  };
  return createToolSession({
    invoke: async (name, args) => {
      const r = await analyze(args, source, null, engine);
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
    },
  });
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("adapts a second plan with verified evidence then returns recorded evidence", async () => {
  const s = session(),
    requests = [],
    updates = [];
  const agent = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    onUpdate: (x) => {
      updates.push(x);
      x.calls = 999;
    },
    propose: async (request) => {
      requests.push(request);
      assert.equal(request.mode, "autonomous");
      if (requests.length === 1) return proposal();
      if (requests.length === 2)
        return proposal(proposedPlan([{ name: "mean" }]));
      const e = await createModelEvidence(
        request.evidenceBundle,
        request.sourceContexts,
      );
      return {
        proposal: { kind: "evidence", claim_ids: [e.claims[0].claim_id] },
        audit: { status: "evidence", proposal_plan_sha256: null },
      };
    },
  });
  const result = await agent.start(settings());
  assert.equal(result.status, "evidence_returned");
  assert.equal(result.calls, 2);
  assert.equal(result.rounds.length, 3);
  assert.equal(
    result.rounds[1].manifest.plan.steps[0].call.arguments.operations[0].name,
    "mean",
  );
  assert.ok(requests[1].evidenceBundle);
  assert.ok(requests[2].history.length === 2);
  assert.equal(result.rounds[0].report.claims.length, 8);
  assert.match(requests[0].prompt, /Request an analysis plan first/);
  result.sources[0].file = "mutated";
  assert.equal(agent.snapshot().sources[0].file, "a.gwy");
  assert.notEqual(agent.snapshot().calls, 999);
  assert.ok(updates.length > 3);
  await assert.rejects(agent.start(settings()), /once/);
  assert.equal(agent.resume().status, "evidence_returned");
});
test("whole plan call budget and round limits terminate without completion claims", async () => {
  const s = session(),
    p = proposedPlan();
  p.steps.push({ ...structuredClone(p.steps[0]), id: "second" });
  const agent = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: () => proposal(p),
  });
  const result = await agent.start({ ...settings(), maxCalls: 1 });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.calls, 0);
  const other = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: () => proposal(),
  });
  assert.equal(
    (await other.start({ ...settings(), maxRounds: 1 })).status,
    "budget_exhausted",
  );
  assert.equal(other.snapshot().calls, 1);
});
test("injected planner cannot escape tuple binding enumerate or use cross-plan artifacts", async () => {
  for (const call of [
    { name: "list_sources", arguments: {} },
    { name: "inspect_source", arguments: { file: "other.gwy" } },
    {
      name: "analyze_surface",
      arguments: {
        file: "a.gwy",
        source_sha256: "b".repeat(64),
        channel: "0",
        operations: [],
      },
    },
    {
      name: "get_artifact",
      arguments: { artifact_id: "artifact:" + "b".repeat(64) },
    },
  ]) {
    let count = 0;
    const p = validatePlan({
      schema_version: 1,
      title: "Unsafe",
      steps: [{ id: "x", call }],
    });
    const a = createAutonomousAgent({
      execute: async () => {
        count++;
      },
      getJournal: () => ({}),
      propose: () => proposal(p),
    });
    assert.equal((await a.start(settings())).status, "failed");
    assert.equal(count, 0);
  }
  const a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: async () => ({
      ...(await proposal()),
      audit: { proposal_plan_sha256: "0".repeat(64) },
    }),
  });
  assert.equal((await a.start(settings())).status, "failed");
});
test("provider failures clarification and invented evidence never become success", async () => {
  for (const [response, status] of [
    [{ proposal: null, audit: { status: "failed" } }, "failed"],
    [
      {
        proposal: { kind: "clarification", question: "Choose an ROI" },
        audit: {},
      },
      "needs_input",
    ],
    [
      { proposal: { kind: "evidence", claim_ids: ["invented"] }, audit: {} },
      "failed",
    ],
  ]) {
    const a = createAutonomousAgent({
      execute: () => assert.fail(),
      getJournal: () => ({}),
      propose: async () => response,
    });
    assert.equal((await a.start(settings())).status, status);
  }
});
test("pause during last tool waits cooperatively and stop wakes it without another call", async () => {
  const s = session(),
    entered = deferred(),
    release = deferred(),
    paused = deferred();
  let a;
  a = createAutonomousAgent({
    getJournal: s.journal,
    propose: () => proposal(),
    execute: async (call) => {
      entered.resolve();
      await release.promise;
      return s.execute(call);
    },
    onUpdate: (snap) => {
      if (
        snap.status === "paused" &&
        snap.rounds[0]?.manifest?.status === "complete"
      )
        paused.resolve();
    },
  });
  assert.equal(a.pause().status, "idle");
  assert.equal(a.resume().status, "idle");
  assert.equal(a.stop().status, "idle");
  const run = a.start(settings());
  await entered.promise;
  a.pause();
  release.resolve();
  await paused.promise;
  assert.equal(a.snapshot().calls, 1);
  a.stop();
  assert.equal((await run).status, "stopped");
  assert.equal(a.snapshot().calls, 1);
});
test("resume continues paused work and stop aborts a pending provider", async () => {
  const s = session(),
    entered = deferred(),
    release = deferred();
  let rounds = 0;
  const a = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: async () => {
      rounds++;
      entered.resolve();
      await release.promise;
      return proposal();
    },
  });
  const running = a.start({ ...settings(), maxRounds: 1 });
  await entered.promise;
  a.pause();
  release.resolve();
  assert.equal(a.snapshot().status, "paused");
  a.resume();
  assert.equal((await running).status, "budget_exhausted");
  assert.equal(rounds, 1);
  const waiting = deferred();
  let signal;
  const stopped = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: async (args) => {
      signal = args.signal;
      waiting.resolve();
      return new Promise(() => {});
    },
  });
  const run = stopped.start(settings());
  await waiting.promise;
  stopped.stop();
  assert.equal((await run).status, "stopped");
  assert.equal(signal.aborted, true);
});
test("settings snapshot and credential reflection never leak through callbacks or snapshots", async () => {
  const entered = deferred(),
    release = deferred(),
    s = session(),
    snapshots = [];
  const a = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    onUpdate: (x) => snapshots.push(x),
    propose: async (args) => {
      entered.resolve();
      await release.promise;
      assert.equal(args.sourceContexts[0].file, "a.gwy");
      return {
        proposal: { kind: "clarification", question: "secret-key" },
        audit: {},
      };
    },
  });
  const input = { ...settings(), apiKey: "secret-key" },
    run = a.start(input);
  input.goal = "changed";
  input.sourceContexts[0].file = "changed";
  await entered.promise;
  release.resolve();
  assert.equal((await run).status, "failed");
  assert.ok(!JSON.stringify([a.snapshot(), snapshots]).includes("secret-key"));
  const b = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: () => assert.fail(),
  });
  assert.equal(
    (await b.start({ ...settings(), apiKey: "secret-key", goal: "secret-key" }))
      .status,
    "failed",
  );
});

test("tool failures stop later execution and thrown exceptions are sanitized", async () => {
  const s = createToolSession({
    invoke: async () => {
      throw new Error("Insufficient valid pixels");
    },
  });
  const a = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: () => proposal(),
  });
  const result = await a.start(settings());
  assert.equal(result.status, "failed");
  assert.equal(result.calls, 1);
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].manifest.status, "failed");
  assert.ok(result.rounds[0].report);
  const b = createAutonomousAgent({
    execute: async () => {
      throw new Error("RAW_EXCEPTION_MARKER");
    },
    getJournal: () => ({
      schema_version: 1,
      tool_version: "1.0.0",
      records: [],
      head_sha256: null,
    }),
    propose: () => proposal(),
  });
  const failed = await b.start(settings());
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("RAW_EXCEPTION_MARKER"));
});
test("mixed source tuples and unselected references are rejected independently", async () => {
  for (const patch of [
    { file: "b.gwy", source_sha256: hash },
    { reference: { file: "b.gwy", source_sha256: hash, channel: "0" } },
    {
      reference: { file: "b.gwy", source_sha256: "b".repeat(64), channel: "1" },
    },
  ]) {
    const p = proposedPlan();
    Object.assign(p.steps[0].call.arguments, patch);
    const a = createAutonomousAgent({
      execute: () => assert.fail(),
      getJournal: () => ({}),
      propose: () => proposal(p),
    });
    assert.equal(
      (
        await a.start({
          ...settings(),
          sourceContexts: [
            ...selected,
            { file: "b.gwy", source_sha256: "b".repeat(64), channel: "0" },
          ],
        })
      ).status,
      "failed",
    );
  }
});
test("invalid bounds getters and reflected plans reject before tool execution", async () => {
  for (const patch of [
    { maxRounds: 0 },
    { maxRounds: 9 },
    { maxCalls: 0 },
    { maxCalls: 65 },
  ]) {
    const a = createAutonomousAgent({
      execute: () => assert.fail(),
      getJournal: () => ({}),
      propose: () => assert.fail(),
    });
    assert.equal((await a.start({ ...settings(), ...patch })).status, "failed");
  }
  let getterCalled = false;
  const bad = settings();
  Object.defineProperty(bad, "goal", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "hidden";
    },
  });
  const a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: () => assert.fail(),
  });
  assert.equal((await a.start(bad)).status, "failed");
  assert.equal(getterCalled, false);
  const p = proposedPlan();
  p.title = "configured-secret";
  const b = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: () => proposal(p),
  });
  assert.ok(
    !JSON.stringify(
      await b.start({ ...settings(), apiKey: "configured-secret" }),
    ).includes("configured-secret"),
  );
});

test("stop retains prepared request audit without waiting for hung provider or late callbacks", async () => {
  const entered = deferred();
  let callback, signal;
  const audit = {
    status: "requesting",
    request_sha256: "b".repeat(64),
    request: { model: "test", messages: [] },
    finished_at: null,
    error: null,
  };
  const a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: async (args) => {
      callback = args.onAudit;
      signal = args.signal;
      await callback(audit);
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const pending = a.start(settings());
  await entered.promise;
  a.stop();
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, "stopped");
  assert.equal(result.error, null);
  assert.equal(result.rounds[0].status, "canceled");
  assert.equal(result.rounds[0].audit.status, "canceled");
  assert.equal(result.rounds[0].audit.request_sha256, audit.request_sha256);
  assert.deepEqual(result.rounds[0].audit.request, audit.request);
  assert.ok(result.rounds[0].audit.finished_at);
  const saved = a.snapshot();
  await callback({ ...audit, status: "failed" });
  assert.deepEqual(a.snapshot(), saved);
});
test("completed provider audit is retained while paused and after stop", async () => {
  const entered = deferred(),
    release = deferred(),
    captured = deferred();
  let a;
  a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: async () => {
      entered.resolve();
      await release.promise;
      return proposal();
    },
    onUpdate: (s) => {
      if (s.status === "paused" && s.rounds[0]?.audit?.status === "proposed")
        captured.resolve();
    },
  });
  const run = a.start(settings());
  await entered.promise;
  a.pause();
  release.resolve();
  await captured.promise;
  assert.equal(a.snapshot().rounds[0].audit.status, "proposed");
  a.stop();
  assert.equal((await run).rounds[0].audit.status, "proposed");
});
test("pause and stop after final report take precedence over budget exhaustion", async () => {
  for (const action of ["stop", "pause"]) {
    const s = createToolSession({ invoke: async () => ({ metadata: "safe" }) }),
      reached = deferred();
    let a,
      fired = false;
    const p = validatePlan({
      schema_version: 1,
      title: "Inspect",
      steps: [
        {
          id: "inspect",
          call: { name: "inspect_source", arguments: { file: "a.gwy" } },
        },
      ],
    });
    a = createAutonomousAgent({
      execute: s.execute,
      getJournal: s.journal,
      propose: () => proposal(p),
      onUpdate: (snap) => {
        if (!fired && snap.rounds[0]?.report) {
          fired = true;
          a[action]();
          reached.resolve();
        }
      },
    });
    const run = a.start({ ...settings(), maxRounds: 1 });
    await reached.promise;
    if (action === "pause") {
      assert.equal(a.snapshot().status, "paused");
      a.stop();
    }
    assert.equal((await run).status, "stopped");
    assert.equal(a.snapshot().calls, 1);
  }
});
test("non-surface completed round reports actual previous run status", async () => {
  const s = createToolSession({ invoke: async () => ({ metadata: "safe" }) }),
    requests = [];
  const p = validatePlan({
    schema_version: 1,
    title: "Inspect",
    steps: [
      {
        id: "inspect",
        call: { name: "inspect_source", arguments: { file: "a.gwy" } },
      },
    ],
  });
  const a = createAutonomousAgent({
    execute: s.execute,
    getJournal: s.journal,
    propose: async (req) => {
      requests.push(req);
      return proposal(p);
    },
  });
  assert.equal(
    (await a.start({ ...settings(), maxRounds: 2 })).status,
    "budget_exhausted",
  );
  assert.match(requests[1].prompt, /Previous run status: complete/);
  assert.equal(requests[1].evidenceBundle, undefined);
});
test("audit callbacks reject secret reflection before retaining any unsafe audit", async () => {
  const updates = [];
  const a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    onUpdate: (s) => updates.push(s),
    propose: async (args) => {
      await args.onAudit({
        status: "requesting",
        request: { content: "private-key" },
      });
      return proposal();
    },
  });
  const r = await a.start({ ...settings(), apiKey: "private-key" });
  assert.equal(r.status, "failed");
  assert.equal(r.rounds[0].audit, null);
  assert.ok(!JSON.stringify(updates).includes("private-key"));
});

test("real planner cancellation retains exact prepared credential-free request audit", async () => {
  const { proposePlan } = await import("../web/model-planner.js");
  const entered = deferred();
  const a = createAutonomousAgent({
    execute: () => assert.fail(),
    getJournal: () => ({}),
    propose: (args) =>
      proposePlan({
        ...args,
        fetchImpl: async () => {
          entered.resolve();
          return new Promise(() => {});
        },
      }),
  });
  const run = a.start({ ...settings(), apiKey: "private-key" });
  await entered.promise;
  a.stop();
  const stopped = await run,
    audit = stopped.rounds[0].audit;
  assert.equal(stopped.status, "stopped");
  assert.equal(audit.status, "canceled");
  assert.equal(audit.request.model, "test");
  assert.ok(audit.finished_at);
  assert.equal(
    audit.request_sha256,
    await sha256(new TextEncoder().encode(JSON.stringify(audit.request))),
  );
  assert.ok(!JSON.stringify(stopped).includes("private-key"));
});

test("SOP records are captured before dispatch and reject altered guidance or unselected settings", async () => {
  const { createSopRecord } = await import("../web/sop-conformance.js");
  const record = createSopRecord("height-roughness", {
    deviations: "Original values deliberately retained.",
  });
  let proposals = 0;
  const agent = () =>
    createAutonomousAgent({
      propose: async () => {
        proposals++;
        return {
          proposal: {
            kind: "clarification",
            question: "Which scientific comparison is required?",
          },
          audit: { status: "clarification" },
        };
      },
      execute: async () => {
        throw Error("Unexpected execution");
      },
      getJournal: () => {
        throw Error("Unexpected journal read");
      },
    });
  const captured = await agent().start({ ...settings(), sop: record });
  assert.equal(captured.status, "needs_input");
  assert.deepEqual(captured.sop, record);
  assert.equal(proposals, 1);
  for (const changed of [
    { ...record, guidance: "altered" },
    { ...record, version: "999" },
    createSopRecord("height-roughness", {
      approved_settings: {
        source: { file: "other.gwy", source_sha256: hash, channel: "0" },
        operations: [],
        selection: {},
        justification: "Known source",
      },
    }),
  ]) {
    assert.equal(
      (await agent().start({ ...settings(), sop: changed })).status,
      "failed",
    );
    assert.equal(proposals, 1);
  }
});
