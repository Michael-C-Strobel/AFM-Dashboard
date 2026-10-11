/** Reverify a downloaded autonomous goal audit; no tools or providers execute. */
import { readFile, stat } from "node:fs/promises";
import { checkSopConformance } from "../web/sop-conformance.js";
try {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error("Usage: node scripts/check-sop.mjs GOAL_AUDIT.json");
  const info = await stat(args[0]);
  if (!info.isFile() || info.size > 128 * 1024 * 1024)
    throw new Error("Expected an audit file no larger than 128 MiB.");
  const bytes = await readFile(args[0]);
  if (bytes.byteLength > 128 * 1024 * 1024)
    throw new Error("Audit is too large.");
  const audit = JSON.parse(bytes.toString("utf8"));
  if (audit.schema_version !== 1 || !Array.isArray(audit.goal?.rounds))
    throw new Error("Expected a downloaded autonomous goal audit.");
  const report = await checkSopConformance({
    record: audit.goal.sop,
    runs: audit.goal.rounds.filter((r) => r.manifest).map((r) => r.manifest),
    journal: audit.journal,
    sources: audit.goal.sources,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = report.status === "records_complete" ? 0 : 2;
} catch (error) {
  process.stderr.write("SOP check failed: " + error.message + "\n");
  process.exitCode = 1;
}
