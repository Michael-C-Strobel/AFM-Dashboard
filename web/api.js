/** Local adapter: analysis messages go to a Web Worker, never to a server. */
let worker,
  nextId = 0;
const pending = new Map(),
  loaded = new Set(),
  loading = new Map();
let files = [];
const pair = {
  raw: "sample-input.gwy",
  reference: "sample-reference.gwy",
};
const manifest = fetch(new URL("../data/manifest.json", import.meta.url))
  .then((r) => (r.ok ? r.json() : { files: [] }))
  .then((x) => {
    files = x.files;
    return files;
  })
  .catch(() => []);
function call(type, payload, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (p) {
        pending.delete(e.data.id);
        e.data.error
          ? p.reject(new Error(e.data.error))
          : p.resolve(e.data.result);
      }
    };
    worker.onerror = () => {
      for (const p of pending.values())
        p.reject(
          new Error("Analysis worker failed. Reload the page to restart."),
        );
      pending.clear();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer);
  });
}
async function ensure(name) {
  await manifest;
  if (loaded.has(name)) return;
  if (loading.has(name)) return loading.get(name);
  const entry = files.find((f) => f.name === name);
  if (!entry) throw new Error(`Load the source file first: ${name}`);
  const promise = (async () => {
    const response = await fetch(
      new URL("../data/" + encodeURIComponent(name), import.meta.url),
    );
    if (!response.ok)
      throw new Error(`Cannot load ${name}; choose the local file instead.`);
    const buffer = await response.arrayBuffer();
    await call("import", { name, buffer }, [buffer]);
    loaded.add(name);
  })();
  loading.set(name, promise);
  try {
    await promise;
  } finally {
    loading.delete(name);
  }
}
export async function apiFetch(path, options = {}) {
  try {
    await manifest;
    const url = new URL(path, "http://local.invalid"),
      route = url.pathname;
    let body;
    if (route === "/api/import") {
      for (const file of options.body) {
        if (file.size > 64 * 1024 * 1024)
          throw new Error("Maximum browser file size is 64 MiB.");
        const buffer = await file.arrayBuffer();
        await call("import", { name: file.name, buffer }, [buffer]);
        loaded.add(file.name);
        if (!files.some((f) => f.name === file.name))
          files.push({ name: file.name, size: file.size });
      }
      return Response.json({ files });
    }
    body = options.body ? JSON.parse(options.body) : {};
    if (route === "/api/files")
      return Response.json({ files, reference_pair: pair });
    if (route === "/api/channels") {
      const file = url.searchParams.get("file");
      await ensure(file);
      return Response.json(await call("channels", { file }));
    }
    if (
      ["/api/batch-check", "/api/batch-run", "/api/batch-export"].includes(
        route,
      )
    ) {
      await ensure(body.file);
      const result = await call(route.slice(5), body);
      return route === "/api/batch-export"
        ? new Response(result, {
            headers: { "Content-Type": "application/x-tar" },
          })
        : Response.json(result);
    }
    if (route === "/api/quality") {
      await ensure(body.file);
      return Response.json(await call("quality", body));
    }
    if (route === "/api/replay") {
      await ensure(body.file ?? body.recipe?.source?.file);
      if (body.recipe.reference) await ensure(body.recipe.reference.file);
      return Response.json(await call("replay", body));
    }
    if (!["/api/analyze", "/api/export"].includes(route))
      throw new Error("Unknown local analysis route.");
    await ensure(body.file);
    if (body.reference) await ensure(body.reference.file);
    const result = await call(
      route === "/api/export" ? "export" : "analyze",
      body,
    );
    return route === "/api/export"
      ? new Response(result, {
          headers: { "Content-Type": "application/x-tar" },
        })
      : Response.json(result);
  } catch (error) {
    return Response.json({ detail: error.message }, { status: 400 });
  }
}
