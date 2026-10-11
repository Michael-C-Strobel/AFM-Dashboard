import { modelOrigin, contentSecurityPolicy } from "./server-policy.mjs";
import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, stat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  port = Number(process.env.PORT ?? 4173),
  host = "127.0.0.1";
const providerOrigin = modelOrigin(process.env.AFM_MODEL_ORIGIN);
const policy = contentSecurityPolicy(providerOrigin);
const liveReload = process.env.AFM_LIVE_RELOAD === "1";
const subscribers = new Set();
let revision = Date.now(),
  timer;
const reloadScript = `const events = new EventSource('/__afm_dev_events');
let previous;
events.onmessage = event => {
  if (previous !== undefined && event.data !== previous) location.reload();
  previous = event.data;
};
addEventListener('pagehide', () => events.close(), {once:true});
`;
const watcher = liveReload
  ? watch(resolve(root, "web"), (_event, name) => {
      if (!name || !/\.(html|css|js)$/.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        revision++;
        for (const response of subscribers)
          response.write(`data: ${revision}\n\n`);
      }, 750);
    })
  : null;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".gwy": "application/octet-stream",
};
const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const hostHeader = req.headers.host ?? "";
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(hostHeader)) {
      res.writeHead(403);
      res.end("Local requests only");
      return;
    }
    const url = new URL(req.url, "http://localhost"),
      path = decodeURIComponent(url.pathname);
    if (path === "/__afm_config.json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        req.method === "HEAD"
          ? undefined
          : JSON.stringify({ model_origin: providerOrigin }),
      );
      return;
    }
    if (liveReload && path === "/__afm_dev_reload.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : reloadScript);
      return;
    }
    if (liveReload && path === "/__afm_dev_events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.write(`data: ${revision}\n\n`);
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }
    if (path === "/") {
      res.writeHead(302, { Location: "/web/" });
      res.end();
      return;
    }
    const relative = path === "/web/" ? "web/index.html" : path.slice(1);
    if (
      !(
        relative.startsWith("web/") ||
        /^data\/[A-Za-z0-9_.-]+\.(gwy|json)$/.test(relative)
      )
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = await realpath(resolve(root, relative));
    if (
      !file.startsWith(resolve(root) + sep) ||
      (relative.startsWith("web/") &&
        !file.startsWith(resolve(root, "web") + sep))
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    let bytes = await readFile(file);
    if (liveReload && extname(file) === ".html") {
      bytes = Buffer.from(
        bytes
          .toString("utf8")
          .replace(
            "</body>",
            '<script type="module" src="/__afm_dev_reload.js"></script></body>',
          ),
      );
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": bytes.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": policy,
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.on("close", () => {
  watcher?.close();
  clearTimeout(timer);
  for (const response of subscribers) response.end();
});
server.listen(port, host, () =>
  console.log(
    `AFM Dashboard: http://${host}:${port}/web/${liveReload ? " (automatic refresh enabled)" : ""}`,
  ),
);
