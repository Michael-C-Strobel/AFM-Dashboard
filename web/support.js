/** Explicit format/configuration support labels; calibration warnings remain independent. */
export function annotateSupport(parsed) {
  const first = Object.values(parsed.channels)[0];
  const metadata = first?.metadata ?? {};
  let support = parsed.support;
  if (parsed.format === "GWYP")
    support = {
      status: "validated",
      format: "GWYP",
      configuration: "Gwyddion native GWYP calibrated image objects",
      message:
        "Supported native image container. Instrument-independent stored calibration is used; acquisition accuracy is not certified.",
    };
  if (parsed.format === "NANOSCOPE") {
    const version = metadata["File list / Version"];
    const scanner = metadata["Scanner list / Scanner type"];
    const mode = metadata["Ciao scan list / Operating mode"];
    const microscope = metadata["Ciao scan list / @MicroscopeList"];
    const validated =
      version === "0x09300201" &&
      scanner === "Dim 4000" &&
      mode === "Image" &&
      microscope?.includes('"PeakForce QNM"');
    support = {
      status: validated ? "validated" : "unverified",
      format: "NANOSCOPE",
      configuration: `NanoScope ${version ?? "unknown version"} / ${scanner ?? "unknown scanner"} / ${microscope ?? mode ?? "unknown mode"}`,
      message: validated
        ? "Supported NanoScope 9.30 / Dim 4000 / PeakForce QNM binary image configuration; channel unit limitations still apply."
        : "Unverified NanoScope instrument/configuration. Binary raster structure is readable, but this acquisition combination has not been independently validated. Review calibration before quantitative use.",
    };
  }
  if (!support)
    throw new Error("Unsupported measurement format/configuration.");
  parsed.support = support;
  if (
    support.status !== "validated" &&
    !parsed.warnings.includes(support.message)
  )
    parsed.warnings.push(support.message);
  for (const channel of Object.values(parsed.channels)) {
    channel.metadata["Import / support"] = JSON.stringify(support);
    if (
      support.status !== "validated" &&
      !channel.warnings.includes(support.message)
    )
      channel.warnings.push(support.message);
  }
  return parsed;
}
