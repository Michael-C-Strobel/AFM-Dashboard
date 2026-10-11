/** Uncompressed POSIX ustar archives; no runtime dependencies. */
const encoder = new TextEncoder();
export function tar(entries) {
  const chunks = [];
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.length > 99)
      throw new Error("Unsafe archive entry name.");
    const data = typeof value === "string" ? encoder.encode(value) : value,
      header = new Uint8Array(512);
    const put = (offset, text, length) =>
      header.set(encoder.encode(text).subarray(0, length), offset);
    put(0, name, 100);
    put(100, "0000644\0", 8);
    put(108, "0000000\0", 8);
    put(116, "0000000\0", 8);
    put(124, data.length.toString(8).padStart(11, "0") + "\0", 12);
    put(136, "00000000000\0", 12);
    put(148, "        ", 8);
    put(156, "0", 1);
    put(257, "ustar\0", 6);
    put(263, "00", 2);
    const checksum = header.reduce((a, b) => a + b, 0);
    put(148, checksum.toString(8).padStart(6, "0") + "\0 ", 8);
    chunks.push(
      header,
      data,
      new Uint8Array((512 - (data.length % 512)) % 512),
    );
  }
  chunks.push(new Uint8Array(1024));
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}
const escape = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export async function exportBundle(result) {
  const lines = [
    "# Row-major grid; values in stored vertical units; blank = excluded or nonfinite",
    ...result.data.map((row) => row.map((v) => v ?? "").join("\t")),
  ];
  const entries = {
    "recipe.json": JSON.stringify(result.recipe, null, 2),
    "analysis.json": JSON.stringify(
      {
        channel: result.channel,
        statistics: result.statistics,
        quality: result.quality,
        history: result.history,
        step: result.step,
        warnings: result.warnings,
        comparison: result.comparison
          ? Object.fromEntries(
              Object.entries(result.comparison).filter(
                ([k]) => !["data", "target"].includes(k),
              ),
            )
          : null,
      },
      null,
      2,
    ),
    "surface.tsv": lines.join("\n"),
    "README.txt":
      "AFM Dashboard reproducible analysis\n\nInput bytes are not included. Obtain the exact source named in recipe.json and verify SHA-256. Replay in the matching application version using Load recipe, or node scripts/afm.mjs replay recipe.json --data-dir PATH --out OUTPUT. Load reference input too if recorded. Data units/calibration and explicit selections are in recipe.json. surface.tsv excludes imported masks and nonfinite values. Original files are never overwritten.\n",
  };
  if (result.profile)
    entries["profile.tsv"] = [
      "distance\theight",
      ...result.profile.distance.map(
        (d, i) => `${d}\t${result.profile.height[i] ?? ""}`,
      ),
    ].join("\n");
  if (typeof OffscreenCanvas !== "undefined") {
    const c = result.channel,
      [height, width] = c.shape,
      canvas = new OffscreenCanvas(width, height),
      ctx = canvas.getContext("2d"),
      pixels = ctx.createImageData(width, height);
    let min = Infinity,
      max = -Infinity;
    for (const row of result.data)
      for (const v of row)
        if (v !== null) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const v = result.data[y][x],
          i = 4 * (y * width + x);
        if (v === null) continue;
        const t = (v - min) / (max - min || 1);
        pixels.data.set(
          [
            Math.round(35 + 215 * t),
            Math.round(35 + 180 * t),
            Math.round(70 + 75 * t),
            255,
          ],
          i,
        );
      }
    ctx.putImageData(pixels, 0, 0);
    const png = new Uint8Array(
      await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
    entries["surface.png"] = png;
    let binary = "";
    for (const b of png) binary += String.fromCharCode(b);
    const image = btoa(binary),
      w = 600,
      h = (600 * c.yreal) / c.xreal;
    // Physical aspect is preserved, including nonsquare pixels.
    entries["figure.svg"] =
      `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${h + 130}" viewBox="0 0 760 ${h + 130}"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#123d35"><text x="60" y="25">${escape(c.title)} — processed surface</text><image x="60" y="45" width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/png;base64,${image}"/><text x="60" y="${h + 70}">x span: ${c.xreal} ${escape(c.xy_unit ?? "unknown")} · y span: ${c.yreal} ${escape(c.xy_unit ?? "unknown")}</text><text x="60" y="${h + 92}">Color range: ${min} to ${max} ${escape(c.z_unit ?? "unknown")} (dark to light)</text><text x="60" y="${h + 112}">Source SHA-256: ${result.source.sha256.slice(0, 24)}… · full provenance in recipe.json</text></g></svg>`;
  }
  return tar(entries);
}
