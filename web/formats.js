/** Detect formats from bytes rather than trusting a filename extension. */
import { parseGwy } from "./gwy.js";
import { parseNanoscope } from "./nanoscope.js";
import { parseIbw } from "./ibw.js";
import { parseJpk } from "./jpk.js";
import { annotateSupport } from "./support.js";
export { summarizeChannel } from "./gwy.js";
export function detectFormat(buffer) {
  if (!(buffer instanceof ArrayBuffer))
    throw new TypeError("Expected measurement bytes as an ArrayBuffer.");
  const bytes = new Uint8Array(buffer),
    start = new TextDecoder().decode(bytes.subarray(0, 16));
  if (start.startsWith("GWYP")) return "GWYP";
  if (start.startsWith("\\*File list")) return "NANOSCOPE";
  if (start.startsWith("GWYO")) return "GWYO";
  if ((bytes[0] === 5 && bytes[1] === 0) || (bytes[0] === 0 && bytes[1] === 5))
    return "IGOR_IBW";
  if (
    (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42) ||
    (bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0)
  )
    return "TIFF";
  return "UNKNOWN";
}
export function parseMeasurement(buffer) {
  const format = detectFormat(buffer);
  if (format === "GWYP")
    return annotateSupport({ ...parseGwy(buffer), format });
  if (format === "NANOSCOPE") return annotateSupport(parseNanoscope(buffer));
  if (format === "IGOR_IBW") return annotateSupport(parseIbw(buffer));
  if (format === "TIFF") return annotateSupport(parseJpk(buffer));
  const descriptions = {
    GWYO: "Legacy Gwyddion GWYO",
    IGOR_IBW: "Igor Binary Wave v5",
    TIFF: "TIFF/JPK",
    UNKNOWN: "This file format",
  };
  throw new Error(
    `${descriptions[format]} is not supported yet. Supported inputs: native GWYP, the documented NanoScope binary image subset, calibrated Igor v5 image waves, and the documented JPK TIFF image subset.`,
  );
}
