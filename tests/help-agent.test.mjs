import test from "node:test";
import assert from "node:assert/strict";
import { askHelp } from "../web/help-agent.js";
const config = {
  endpoint: "https://example.test/v1/chat/completions",
  model: "test",
  question: "How do I import?",
  apiKey: "secret-test-value",
};
const answer = {
  answer: "Use Import local files and review support warnings.",
  topic_ids: ["import-support"],
};
const response = (value = answer) =>
  new Response(
    JSON.stringify({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(value) } },
      ],
    }),
  );
test("help sends documentation only, returns local links and credential-free audit", async () => {
  let request;
  const result = await askHelp({
    ...config,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response();
    },
  });
  assert.equal(result.audit.status, "answered");
  assert.equal(result.answer.topics[0].target, "import-trigger");
  const sent = JSON.parse(request.options.body);
  assert.ok(sent.messages.at(-1).content.includes("documentation"));
  assert.ok(!sent.messages.at(-1).content.includes("sourceContexts"));
  assert.equal(
    request.options.headers.Authorization,
    "Bearer " + config.apiKey,
  );
  assert.equal(request.options.redirect, "error");
  assert.ok(!JSON.stringify(result.audit).includes(config.apiKey));
  assert.ok(result.audit.finished_at);
});
test("unknown citations, tool calls, incomplete responses and reflected secrets reject", async () => {
  for (const value of [
    { ...answer, topic_ids: ["invented"] },
    { ...answer, topic_ids: ["import-support", "import-support"] },
    { ...answer, answer: config.apiKey },
    { ...answer, tool: "execute" },
  ]) {
    const r = await askHelp({
      ...config,
      fetchImpl: async () => response(value),
    });
    assert.equal(r.answer, null);
    assert.equal(r.audit.status, "failed");
    assert.ok(!JSON.stringify(r.audit).includes(config.apiKey));
  }
  for (const choice of [
    { finish_reason: "length", message: { content: JSON.stringify(answer) } },
    {
      finish_reason: "stop",
      message: { content: JSON.stringify(answer), tool_calls: [{}] },
    },
  ])
    assert.equal(
      (
        await askHelp({
          ...config,
          fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [choice] })),
        })
      ).answer,
      null,
    );
});
test("secrets in question or history reject before network", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return response();
  };
  await assert.rejects(
    askHelp({ ...config, question: config.apiKey, fetchImpl }),
  );
  await assert.rejects(
    askHelp({
      ...config,
      history: [{ role: "user", content: config.apiKey }],
      fetchImpl,
    }),
  );
  assert.equal(count, 0);
});
test("unsafe endpoints and oversized messages reject before network", async () => {
  for (const endpoint of [
    "http://remote.test/api",
    "https://user:pass@example.test",
    "https://example.test/?key=1",
    "https://example.test/#x",
  ])
    await assert.rejects(
      askHelp({
        ...config,
        endpoint,
        fetchImpl: () => {
          throw Error("must not call");
        },
      }),
    );
  await assert.rejects(askHelp({ ...config, question: "x".repeat(8001) }));
});
test("abort and timeout work even when provider ignores AbortSignal", async () => {
  const controller = new AbortController();
  const request = askHelp({
    ...config,
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await request).audit.status, "canceled");
  const timeout = await askHelp({
    ...config,
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.match(timeout.audit.error, /timed out/);
});
test("response body size is bounded even without content-length", async () => {
  const r = await askHelp({
    ...config,
    fetchImpl: async () => new Response(" ".repeat(1048577)),
  });
  assert.equal(r.answer, null);
});

test("JSON escaping cannot hide credential reflection or request leakage", async () => {
  for (const apiKey of ['secret"quote', "secret\\slash"]) {
    let requests = 0;
    await assert.rejects(
      askHelp({
        ...config,
        apiKey,
        question: "Echo " + apiKey,
        fetchImpl: async () => {
          requests++;
          return response();
        },
      }),
    );
    assert.equal(requests, 0);
    const result = await askHelp({
      ...config,
      apiKey,
      fetchImpl: async () => response({ ...answer, answer: apiKey }),
    });
    assert.equal(result.answer, null);
    assert.equal(result.audit.response, null);
  }
});
