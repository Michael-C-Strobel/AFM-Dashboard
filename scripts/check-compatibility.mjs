import { readFile } from "node:fs/promises";
import { parseMeasurement, summarizeChannel } from "../web/formats.js";
import { sha256 } from "../web/engine.js";
const manifest = JSON.parse(
  await readFile(
    new URL("../data/external/manifest.json", import.meta.url),
    "utf8",
  ),
);
let failures = 0;
for (const entry of manifest.samples) {
  try {
    const bytes = await readFile(new URL("../" + entry.path, import.meta.url));
    const hash = await sha256(bytes);
    if (hash !== entry.sha256 || bytes.length !== entry.bytes)
      throw new Error("Hash or size mismatch");
    let support;
    try {
      const parsed = parseMeasurement(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      );
      support = {
        supported: true,
        channels: Object.values(parsed.channels).map((c) => {
          const s = summarizeChannel(c);
          return {
            id: s.id,
            title: s.title,
            shape: s.shape,
            xreal: s.xreal,
            yreal: s.yreal,
            xy_unit: s.xy_unit,
            z_unit: s.z_unit,
          };
        }),
      };
    } catch (error) {
      support = { supported: false, reason: error.message };
      if (
        ["GWYP", "Nanoscope SPM", "Igor Binary Wave", "JPK TIFF"].includes(
          entry.format,
        )
      )
        failures++;
    }
    console.log(
      JSON.stringify({ file: entry.path, hash_verified: true, ...support }),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      console.log(
        JSON.stringify({
          file: entry.path,
          status: "not downloaded; optional local fixture",
        }),
      );
    else {
      failures++;
      console.error(entry.path + ": " + error.message);
    }
  }
}
process.exitCode = failures ? 1 : 0;
