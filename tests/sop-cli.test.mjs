import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createSopRecord } from "../web/sop-conformance.js";
import { createToolSession } from "../web/tool-session.js";
const exec = promisify(execFile);
test("SOP CLI reconstructs incomplete reports and rejects forged journals instead of trusting saved status", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "afm-sop-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "audit.json"),
    script = new URL("../scripts/check-sop.mjs", import.meta.url).pathname;
  const session = createToolSession({
    invoke: async () => {
      throw Error("unused");
    },
  });
  const audit = {
    schema_version: 1,
    goal: {
      sop: createSopRecord("height-roughness"),
      rounds: [],
      sources: [
        { file: "synthetic.gwy", source_sha256: "a".repeat(64), channel: "0" },
      ],
    },
    journal: session.journal(),
    sop_conformance: { status: "records_complete" },
  };
  await writeFile(file, JSON.stringify(audit));
  const incomplete = await exec(process.execPath, [script, file]).catch(
    (e) => e,
  );
  assert.equal(incomplete.code, 2);
  const report = JSON.parse(incomplete.stdout);
  assert.equal(report.status, "incomplete");
  assert.ok(
    report.checks.some((c) => c.id === "replay" && c.status === "missing"),
  );
  assert.ok(report.review_required.length);
  audit.journal.head_sha256 = "b".repeat(64);
  await writeFile(file, JSON.stringify(audit));
  const invalid = await exec(process.execPath, [script, file]).catch((e) => e);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /SOP check failed/);
});
