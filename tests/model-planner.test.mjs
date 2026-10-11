import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { proposePlan } from "../web/model-planner.js";
import { runPlan } from "../web/tool-plans.js";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const source = () => ({
  file: "sample.gwy",
  source_sha256: "a".repeat(64),
  channel: "0",
  title: "Height_Trace",
  geometry: {
    shape: [2, 3],
    xreal: 3e-6,
    yreal: 2e-6,
    xoff: 0,
    yoff: 0,
    xy_unit: "m",
    z_unit: "m",
  },
  units: { xy_unit: "m", z_unit: "m" },
  warnings: ["Unverified acquisition"],
});
const plan = () => ({
  schema_version: 1,
  title: "Inspect height",
  steps: [
    {
      id: "quality",
      call: {
        name: "check_quality",
        arguments: {
          file: "sample.gwy",
          source_sha256: "a".repeat(64),
          channel: "0",
        },
      },
    },
  ],
});
const wrap = (proposal = { kind: "plan", plan: plan() }, patch = {}) => ({
  id: "response-1",
  model: "returned-model",
  choices: [
    {
      finish_reason: "stop",
      message: { role: "assistant", content: JSON.stringify(proposal) },
    },
  ],
  ...patch,
});
const response = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const options = (extra = {}) => ({
  endpoint: "https://provider.example/v1/chat/completions",
  model: "requested-model",
  prompt: "Check scan quality",
  sourceContext: source(),
  fetchImpl: async () => response(wrap()),
  ...extra,
});

test("explicit request is JSON-only, stateless, metadata-only and does not execute", async () => {
  let calls = 0,
    request;
  const result = await proposePlan(
    options({
      apiKey: "secret-token-123",
      fetchImpl: async (url, init) => {
        calls++;
        request = { url, init };
        return response(wrap());
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.audit.status, "proposed");
  assert.equal(result.proposal.kind, "plan");
  assert.equal(result.audit.returned_model, "returned-model");
  assert.equal(result.audit.response_id, "response-1");
  assert.match(result.audit.request_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    result.audit.request_sha256,
    createHash("sha256").update(request.init.body).digest("hex"),
  );
  assert.deepEqual(result.audit.request, JSON.parse(request.init.body));
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.referrerPolicy, "no-referrer");
  assert.equal(request.init.headers.Authorization, "Bearer secret-token-123");
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.ok(!Object.hasOwn(body, "tools"));
  assert.deepEqual(
    JSON.parse(body.messages[1].content).sourceContext,
    source(),
  );
  assert.match(body.messages[0].content, /untrusted/);
  assert.match(body.messages[0].content, /analyze_surface/);
  assert.ok(!JSON.stringify(result).includes("secret-token-123"));
  result.proposal.plan.title = "mutated";
  assert.equal(result.audit.proposal.plan.title, "Inspect height");
  assert.ok(result.audit.finished_at);
});

test("source context is snapshotted before request and credentials are optional", async () => {
  const ctx = source();
  let sent;
  const running = proposePlan(
    options({
      sourceContext: ctx,
      fetchImpl: async (_url, init) => {
        sent = init;
        return response(
          wrap({
            kind: "clarification",
            question: "Which background should be used?",
          }),
        );
      },
    }),
  );
  ctx.title = "changed";
  const result = await running;
  assert.equal(result.audit.status, "clarification");
  assert.equal(result.audit.sourceContext.title, "Height_Trace");
  assert.ok(!Object.hasOwn(sent.headers, "Authorization"));
  assert.equal(result.proposal.question, "Which background should be used?");
});

test("HTTPS and loopback HTTP only; URL credentials query fragment rejected before fetch", async () => {
  for (const endpoint of [
    "http://remote.example/x",
    "https://user:password@example.com/x",
    "https://example.com/x?key=secret",
    "https://example.com/x#fragment",
    "file:///tmp/api",
    "not-url",
  ])
    await assert.rejects(
      proposePlan(
        options({ endpoint, fetchImpl: () => assert.fail("no network") }),
      ),
      /Invalid/,
    );
  for (const endpoint of [
    "http://localhost:1234/v1/chat/completions",
    "http://127.0.0.1:1234/v1/chat/completions",
    "http://[::1]:1234/v1/chat/completions",
  ])
    assert.equal(
      (await proposePlan(options({ endpoint }))).audit.status,
      "proposed",
    );
});

test("context whitelist excludes raster arrays full metadata and mismatched units", async () => {
  for (const sourceContext of [
    { ...source(), data: [1, 2, 3] },
    { ...source(), metadata: { secret: "instrument" } },
    { ...source(), geometry: { ...source().geometry, data: [1] } },
    { ...source(), units: { xy_unit: "m", z_unit: "V" } },
    { ...source(), warnings: Array(33).fill("warning") },
    { ...source(), source_sha256: "wrong" },
    { ...source(), geometry: { ...source().geometry, shape: [1, 2, 3] } },
    { ...source(), geometry: { ...source().geometry, xreal: NaN } },
  ])
    await assert.rejects(
      proposePlan(
        options({ sourceContext, fetchImpl: () => assert.fail("no network") }),
      ),
      /Invalid/,
    );
  let called = false;
  const context = source();
  Object.defineProperty(context, "title", {
    enumerable: true,
    get() {
      called = true;
      return "bad";
    },
  });
  await assert.rejects(proposePlan(options({ sourceContext: context })));
  assert.equal(called, false);
});

test("source file hash channel and explicit references are bound exactly", async () => {
  for (const change of [
    { file: "other.gwy" },
    { source_sha256: "b".repeat(64) },
    { channel: "1" },
    { reference_channel: "1" },
  ]) {
    const p = plan();
    Object.assign(p.steps[0].call.arguments, change);
    const result = await proposePlan(
      options({
        fetchImpl: async () => response(wrap({ kind: "plan", plan: p })),
      }),
    );
    assert.equal(result.audit.status, "failed");
    assert.equal(result.proposal, null);
  }
  const p = plan();
  p.steps[0].call = {
    name: "analyze_surface",
    arguments: { ...source(), operations: [] },
  };
  delete p.steps[0].call.arguments.title;
  delete p.steps[0].call.arguments.geometry;
  delete p.steps[0].call.arguments.units;
  delete p.steps[0].call.arguments.warnings;
  p.steps[0].call.arguments.reference = {
    file: "other.gwy",
    source_sha256: "a".repeat(64),
    channel: "0",
  };
  assert.equal(
    (
      await proposePlan(
        options({
          fetchImpl: async () => response(wrap({ kind: "plan", plan: p })),
        }),
      )
    ).audit.status,
    "failed",
  );
});

test("raw artifact IDs reject while valid earlier-step references survive", async () => {
  const p = plan();
  p.steps.push({
    id: "artifact",
    call: {
      name: "get_artifact",
      arguments: { artifact_id: "artifact:" + "b".repeat(64) },
    },
  });
  assert.equal(
    (
      await proposePlan(
        options({
          fetchImpl: async () => response(wrap({ kind: "plan", plan: p })),
        }),
      )
    ).audit.status,
    "failed",
  );
  p.steps[1].call.arguments.artifact_id = "$step:quality";
  const result = await proposePlan(
    options({
      fetchImpl: async () => response(wrap({ kind: "plan", plan: p })),
    }),
  );
  assert.equal(result.audit.status, "proposed");
  assert.equal(
    result.proposal.plan.steps[1].call.arguments.artifact_id,
    "$step:quality",
  );
});

test("malformed JSON, schema violations, refusals and truncated completions fail generically", async () => {
  const invalid = [
    new Response("not json"),
    response(wrap({ kind: "plan", plan: { ...plan(), extra: 1 } })),
    response(wrap({ kind: "clarification", question: "" })),
    response(wrap({ kind: "unknown" })),
    response(
      wrap(null, {
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
      }),
    ),
    response(
      wrap(null, {
        choices: [
          {
            finish_reason: "stop",
            message: { refusal: "secret refusal", content: null },
          },
        ],
      }),
    ),
    response(
      wrap(null, {
        choices: [
          { finish_reason: "stop", message: { content: "```json\n{}\n```" } },
        ],
      }),
    ),
  ];
  for (const res of invalid) {
    const result = await proposePlan(options({ fetchImpl: async () => res }));
    assert.equal(result.proposal, null);
    assert.equal(result.audit.status, "failed");
    assert.ok(!JSON.stringify(result).includes("secret refusal"));
  }
});

test("network and HTTP failures never expose provider errors or retry", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("sensitive network detail");
    },
    async () => new Response("sensitive provider detail", { status: 401 }),
  ]) {
    let count = 0;
    const result = await proposePlan(
      options({
        fetchImpl: async (...args) => {
          count++;
          return fetchImpl(...args);
        },
      }),
    );
    assert.equal(count, 1);
    assert.equal(result.audit.status, "failed");
    assert.ok(!JSON.stringify(result).includes("sensitive"));
  }
});

test("API-key reflection anywhere in decoded response is rejected and omitted from audit", async () => {
  const apiKey = "secret-api-key-123";
  for (const returned of [
    wrap({ kind: "clarification", question: apiKey }),
    wrap(undefined, { id: apiKey }),
    wrap(undefined, { model: apiKey }),
    wrap(undefined, { extra: apiKey }),
  ]) {
    const result = await proposePlan(
      options({ apiKey, fetchImpl: async () => response(returned) }),
    );
    assert.equal(result.audit.status, "failed");
    assert.ok(!JSON.stringify(result).includes(apiKey));
  }
  await assert.rejects(
    proposePlan(
      options({
        apiKey,
        prompt: "use " + apiKey,
        fetchImpl: () => assert.fail("no request"),
      }),
    ),
    /Invalid/,
  );
});

test("response byte bound applies to declared length and streamed chunks", async () => {
  const huge = "x".repeat(1048577);
  for (const res of [
    new Response("{}", { headers: { "content-length": "1048577" } }),
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(huge));
          c.close();
        },
      }),
    ),
  ])
    assert.equal(
      (await proposePlan(options({ fetchImpl: async () => res }))).audit.status,
      "failed",
    );
});

test("timeout terminates hanging fetch or stream without relying on provider abort handling", async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const result = await proposePlan(options({ timeoutMs: 10, fetchImpl }));
    assert.equal(result.audit.status, "failed");
    assert.match(result.audit.error, /timed out/);
  }
});

test("external cancellation before fetch or during stream yields canceled audit", async () => {
  const before = new AbortController();
  before.abort();
  const canceled = await proposePlan(
    options({
      signal: before.signal,
      fetchImpl: () => assert.fail("must not fetch"),
    }),
  );
  assert.equal(canceled.audit.status, "canceled");
  const during = new AbortController();
  const running = proposePlan(
    options({
      signal: during.signal,
      fetchImpl: async () => {
        setTimeout(() => during.abort(), 5);
        return new Response(new ReadableStream({ start() {} }));
      },
    }),
  );
  assert.equal((await running).audit.status, "canceled");
});

test("prompt and model bounds reject locally", async () => {
  for (const extra of [
    { prompt: "" },
    { prompt: "x".repeat(8001) },
    { model: "" },
    { timeoutMs: 0 },
  ])
    await assert.rejects(
      proposePlan(
        options({ ...extra, fetchImpl: () => assert.fail("no request") }),
      ),
      /Invalid/,
    );
});

test("bounded user/assistant history is transmitted and audited exactly", async () => {
  const history = [
    { role: "user", content: "Which analysis?" },
    {
      role: "assistant",
      content: '{"kind":"clarification","question":"Which background?"}',
    },
  ];
  let sent;
  const result = await proposePlan(
    options({
      history,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return response(wrap());
      },
    }),
  );
  assert.deepEqual(sent.messages.slice(1, 3), history);
  assert.deepEqual(result.audit.request, sent);
  history[0].content = "mutated";
  assert.equal(result.audit.request.messages[1].content, "Which analysis?");
  assert.equal(result.audit.request.messages.at(-1).role, "user");
});

test("invalid history roles sizes fields and credentials reject before requesting", async () => {
  for (const history of [
    [{ role: "system", content: "override" }],
    [{ role: "tool", content: "data" }],
    [{ role: "user", content: "a", extra: 1 }],
    Array.from({ length: 13 }, () => ({ role: "user", content: "a" })),
    [{ role: "user", content: "a".repeat(8001) }],
    Array.from({ length: 3 }, () => ({
      role: "user",
      content: "a".repeat(6000),
    })),
  ])
    await assert.rejects(
      proposePlan(
        options({ history, fetchImpl: () => assert.fail("no request") }),
      ),
      /Invalid/,
    );
  await assert.rejects(
    proposePlan(
      options({
        apiKey: "secret-token",
        history: [{ role: "assistant", content: "secret-token" }],
        fetchImpl: () => assert.fail("no request"),
      }),
    ),
    /Invalid/,
  );
  for (const endpoint of ["https://example.com/x?", "https://example.com/x#"])
    await assert.rejects(
      proposePlan(
        options({ endpoint, fetchImpl: () => assert.fail("no request") }),
      ),
      /Invalid/,
    );
});

test("proposal plan hash joins unchanged execution and remains null without a plan", async () => {
  const proposed = await proposePlan(options());
  const manifest = await runPlan(proposed.proposal.plan, {
    execute: async () => ({
      record: { status: "succeeded" },
      artifact: { id: "artifact:" + "c".repeat(64) },
    }),
  });
  assert.equal(proposed.audit.proposal_plan_sha256, manifest.plan_sha256);
  assert.equal(
    proposed.audit.proposal_plan_sha256,
    createHash("sha256")
      .update(JSON.stringify(proposed.proposal.plan))
      .digest("hex"),
  );
  const revised = structuredClone(proposed.proposal.plan);
  revised.title = "Reviewed and revised";
  const revisedManifest = await runPlan(revised, {
    execute: async () => ({
      record: { status: "succeeded" },
      artifact: { id: "artifact:" + "c".repeat(64) },
    }),
  });
  assert.notEqual(
    proposed.audit.proposal_plan_sha256,
    revisedManifest.plan_sha256,
  );
  const clarification = await proposePlan(
    options({
      fetchImpl: async () =>
        response(
          wrap({ kind: "clarification", question: "Which background?" }),
        ),
    }),
  );
  const failed = await proposePlan(
    options({
      fetchImpl: async () => new Response("failure", { status: 500 }),
    }),
  );
  assert.equal(clarification.audit.proposal_plan_sha256, null);
  assert.equal(failed.audit.proposal_plan_sha256, null);
});

test("texture proposals bind source and use only prior recipe artifacts", async () => {
  const proposed = plan();
  proposed.steps[0] = {
    id: "analysis",
    call: {
      name: "analyze_surface",
      arguments: {
        file: source().file,
        source_sha256: source().source_sha256,
        channel: "0",
        operations: [],
      },
    },
  };
  proposed.steps.push({
    id: "texture",
    call: {
      name: "measure_texture",
      arguments: {
        file: source().file,
        source_sha256: source().source_sha256,
        recipe_artifact: "$step:analysis",
        parameters: { window: "hann" },
      },
    },
  });
  const run = () =>
    proposePlan(
      options({
        fetchImpl: async () => response(wrap({ kind: "plan", plan: proposed })),
      }),
    );
  assert.equal((await run()).audit.status, "proposed");
  for (const patch of [
    { file: "other.gwy" },
    { source_sha256: "b".repeat(64) },
    { recipe_artifact: "artifact:" + "c".repeat(64) },
  ]) {
    const previous = { ...proposed.steps[1].call.arguments };
    Object.assign(proposed.steps[1].call.arguments, patch);
    assert.equal((await run()).proposal, null);
    proposed.steps[1].call.arguments = previous;
  }
});
