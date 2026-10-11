import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  helpTopics,
  helpContext,
  resolveHelpTopics,
} from "../web/help-knowledge.js";
const tabs = [
  "measurements",
  "acquisition",
  "batch",
  "assistant",
  "features",
  "texture",
  "registration",
  "sensitivity",
].map((id) => "tab-" + id);

test("curated help has unique stable IDs and targets actual interface elements", async () => {
  const html = await readFile(
    new URL("../web/index.html", import.meta.url),
    "utf8",
  );
  const js = await readFile(
    new URL("../web/assistant.js", import.meta.url),
    "utf8",
  );
  const ids = new Set(
    [
      ...html.matchAll(/\bid="([^"]+)"/g),
      ...js.matchAll(/\.id\s*=\s*"([^"]+)"/g),
    ].map((match) => match[1]),
  );
  assert.equal(new Set(helpTopics.map((t) => t.id)).size, helpTopics.length);
  for (const topic of helpTopics) {
    assert.deepEqual(Object.keys(topic), ["id", "title", "target", "text"]);
    assert.match(topic.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(topic.title.length > 0 && topic.text.length > 0);
    if (topic.target !== null)
      assert.ok(ids.has(topic.target), "Missing help target " + topic.target);
  }
  for (const id of [
    "import-support",
    "units-calibration",
    "processing",
    "selection",
    "profiles-plateaus",
    "quality",
    "batch",
    "segmentation",
    "texture",
    "registration",
    "sensitivity",
    "recipes-export",
    "assistant",
    "navigation",
    "limitations",
  ])
    assert.ok(helpTopics.some((t) => t.id === id));
});

test("context is deterministic bounded plain JSON with only known tab context", () => {
  for (const tab of [
    null,
    ...tabs,
    "unknown",
    {},
    "tab-texture SECRET_MEASUREMENT",
  ]) {
    const context = helpContext({
      tab,
      measurement: "PRIVATE_MEASUREMENT",
      data: [1, 2, 3],
    });
    assert.equal(context.schema_version, 1);
    assert.equal(context.tab, tabs.includes(tab) ? tab : null);
    assert.deepEqual(context, JSON.parse(JSON.stringify(context)));
    assert.deepEqual(context, helpContext({ tab }));
    assert.ok(Buffer.byteLength(JSON.stringify(context)) < 32768);
    assert.ok(!JSON.stringify(context).includes("PRIVATE_MEASUREMENT"));
    assert.ok(!JSON.stringify(context).includes("SECRET_MEASUREMENT"));
    assert.deepEqual(Object.keys(context), ["schema_version", "tab", "topics"]);
  }
  assert.equal(helpContext({ tab: "tab-texture" }).topics[0].id, "texture");
  assert.equal(
    helpContext({ tab: "tab-features" }).topics[0].id,
    "segmentation",
  );
  assert.equal(helpContext(Object.create({ tab: "tab-texture" })).tab, null);
  const accessor = {
    get tab() {
      throw Error("must not invoke");
    },
  };
  assert.equal(helpContext(accessor).tab, null);
});

test("contexts and resolved topics are detached from immutable curated definitions", () => {
  const context = helpContext();
  context.topics[0].text = "changed";
  context.topics.pop();
  assert.notEqual(helpContext().topics[0].text, "changed");
  const resolved = resolveHelpTopics(["texture", "processing"]);
  resolved[0].target = "invented";
  resolved.push({ id: "bad" });
  assert.equal(resolveHelpTopics(["texture"])[0].target, "tab-texture");
  assert.equal(Object.isFrozen(helpTopics), true);
  assert.equal(Object.isFrozen(helpTopics[0]), true);
  assert.deepEqual(
    resolveHelpTopics(["texture", "processing"]).map((t) => t.id),
    ["texture", "processing"],
  );
});

test("resolver rejects unknown duplicate excessive sparse or accessor IDs", () => {
  for (const ids of [
    null,
    {},
    "texture",
    [],
    ["texture", "texture"],
    ["unknown"],
    ["texture "],
    Array(2),
    Array(9).fill("texture"),
    [{}, "texture"],
  ])
    assert.throws(() => resolveHelpTopics(ids), /1–8/);
  const getter = [];
  Object.defineProperty(getter, "0", {
    enumerable: true,
    get() {
      throw Error("must not invoke");
    },
  });
  assert.throws(() => resolveHelpTopics(getter), /1–8/);
  const extended = ["texture"];
  extended.extra = "data";
  assert.throws(() => resolveHelpTopics(extended), /1–8/);
  const symbol = ["texture"];
  symbol[Symbol("data")] = 1;
  assert.throws(() => resolveHelpTopics(symbol), /1–8/);
});

test("help module has no DOM measurement or network dependency", async () => {
  const source = await readFile(
    new URL("../web/help-knowledge.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /(?:^|\n)\s*import\b|\bfetch\s*\(|document\.|window\.|localStorage|sessionStorage/,
  );
  assert.ok(
    helpTopics
      .find((t) => t.id === "assistant")
      .text.includes("never run automatically"),
  );
  assert.ok(
    helpTopics
      .find((t) => t.id === "sensitivity")
      .text.includes("not independent-replicate uncertainty"),
  );
});
