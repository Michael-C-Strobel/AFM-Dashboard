/** Sequential, detached batch state; no UI, network or session dependencies. */
import { ENGINE_VERSION, SCHEMA_VERSION, geometry, sha256 } from "./engine.js";

export function makeBatchRequest(template, source, engineIdentity, file) {
  if (template?.schema_version !== SCHEMA_VERSION)
    throw new Error("Batch template schema is incompatible.");
  if (
    template.engine?.name !== "afm-dashboard-js" ||
    template.engine?.version !== ENGINE_VERSION ||
    typeof engineIdentity !== "string" ||
    !engineIdentity ||
    template.engine?.sha256 !== engineIdentity
  )
    throw new Error("Batch template engine identity is incompatible.");
  if (template.reference != null)
    throw new Error("Batch templates must not contain a reference comparison");
  if (
    !Array.isArray(template.operations) ||
    !Object.hasOwn(template, "selection") ||
    !template.selection ||
    typeof template.selection !== "object" ||
    Array.isArray(template.selection)
  )
    throw new Error(
      "Batch template requires explicit operations and selection.",
    );
  if (typeof file !== "string" || !file.trim())
    throw new Error("Batch input filename must be a nonempty string.");
  const id = template.source?.channel;
  if (
    typeof id !== "string" ||
    !id ||
    !Object.hasOwn(source?.channels ?? {}, id)
  )
    throw new Error("Batch template channel is missing or incompatible.");
  const channel = source.channels[id];
  if (
    String(channel.id) !== id ||
    typeof template.source.title !== "string" ||
    template.source.title !== channel.title
  )
    throw new Error("Batch template channel title or ID is incompatible.");
  const expected = template.source.geometry,
    actual = geometry(channel);
  if (
    !expected ||
    !Array.isArray(expected.shape) ||
    expected.shape.length !== 2 ||
    expected.shape.some((v, i) => v !== actual.shape[i])
  )
    throw new Error("Batch template channel geometry is incompatible.");
  for (const key of ["xreal", "yreal", "xoff", "yoff", "xy_unit", "z_unit"]) {
    if (!Object.hasOwn(expected, key) || expected[key] !== actual[key])
      throw new Error(
        `Batch template channel geometry is incompatible: ${key}`,
      );
  }
  return structuredClone({
    file,
    channel: id,
    operations: template.operations,
    selection: template.selection,
    profile: template.profile ?? null,
    plateaus: template.plateaus ?? null,
  });
}

export async function runBatch({
  template,
  files,
  execute,
  onUpdate = () => {},
  shouldCancel = () => false,
}) {
  // Capture the complete input before hashing or invoking any asynchronous code.
  const snapshot = structuredClone(template),
    names = structuredClone(files);
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.some((name) => typeof name !== "string" || !name.trim()) ||
    new Set(names).size !== names.length
  )
    throw new Error("Batch files must be nonempty, unique filename strings.");
  if (
    typeof execute !== "function" ||
    typeof onUpdate !== "function" ||
    typeof shouldCancel !== "function"
  )
    throw new Error("Invalid batch callbacks.");
  const serialized = JSON.stringify(snapshot);
  if (typeof serialized !== "string")
    throw new Error("Batch template must be JSON serializable.");
  const manifest = {
    schema_version: 1,
    template_sha256: await sha256(new TextEncoder().encode(serialized)),
    template: snapshot,
    canceled: false,
    records: names.map((file) => ({ file, status: "pending" })),
  };
  const update = () => onUpdate(structuredClone(manifest));
  await update();
  for (let i = 0; i < manifest.records.length; i++) {
    if (shouldCancel()) {
      manifest.canceled = true;
      for (const record of manifest.records.slice(i)) record.status = "not_run";
      await update();
      break;
    }
    const record = manifest.records[i];
    record.status = "running";
    await update();
    try {
      const metadata = await execute(record.file, structuredClone(snapshot));
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        ArrayBuffer.isView(metadata) ||
        metadata instanceof ArrayBuffer
      )
        throw new Error("Batch execution must return a metadata object.");
      record.result = structuredClone(metadata);
      record.status = "complete";
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    await update();
  }
  return structuredClone(manifest);
}
