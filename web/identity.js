/** Format-specific code identities keep existing GWYP recipes replayable. */
export function engineSources(format = "GWYP") {
  if (format === "GWYP") return ["gwy.js", "engine.js", "service.js"];
  if (format === "NANOSCOPE")
    return [
      "nanoscope.js",
      "support.js",
      "formats.js",
      "gwy.js",
      "engine.js",
      "service.js",
      "identity.js",
    ];
  if (format === "IGOR_IBW")
    return ["ibw.js", "support.js", "engine.js", "service.js"];
  if (format === "JPK_TIFF")
    return ["jpk.js", "support.js", "engine.js", "service.js"];
  throw new Error("Cannot identify an unsupported reader.");
}
