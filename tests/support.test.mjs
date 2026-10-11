import test from "node:test";
import assert from "node:assert/strict";
import { annotateSupport } from "../web/support.js";
function source(format, metadata = {}) {
  return { format, channels: { 0: { metadata, warnings: [] } }, warnings: [] };
}
const known = {
  "File list / Version": "0x09300201",
  "Scanner list / Scanner type": "Dim 4000",
  "Ciao scan list / Operating mode": "Image",
  "Ciao scan list / @MicroscopeList": 'S [SoftHarmoniX] "PeakForce QNM"',
};
test("known NanoScope configuration is identified without certifying material-property units", () => {
  const parsed = annotateSupport(source("NANOSCOPE", { ...known }));
  assert.equal(parsed.support.status, "validated");
  assert.match(parsed.support.message, /unit limitations/);
  assert.deepEqual(
    JSON.parse(parsed.channels[0].metadata["Import / support"]),
    parsed.support,
  );
});
test("changed scanner, software, mode, or missing instrument warns in channel and source records", () => {
  for (const key of Object.keys(known)) {
    const metadata = { ...known };
    delete metadata[key];
    const parsed = annotateSupport(source("NANOSCOPE", metadata));
    assert.equal(parsed.support.status, "unverified");
    assert.match(parsed.warnings.join(" "), /Unverified.*configuration/);
    assert.ok(parsed.channels[0].warnings.includes(parsed.support.message));
  }
  const parsed = annotateSupport(
    source("NANOSCOPE", {
      ...known,
      "Scanner list / Scanner type": "Other scanner",
    }),
  );
  assert.equal(parsed.support.status, "unverified");
});
test("GWYP supports the calibrated container, without claiming instrument certification", () => {
  const parsed = annotateSupport(source("GWYP"));
  assert.equal(parsed.support.status, "validated");
  assert.match(parsed.support.message, /acquisition accuracy is not certified/);
});
test("a format outside the support registry is rejected", () => {
  assert.throws(
    () => annotateSupport(source("TIFF")),
    /Unsupported measurement format/,
  );
});
