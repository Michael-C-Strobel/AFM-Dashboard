import { createServer } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)),
  port = Number(process.env.PORT ?? 4173),
  host = "127.0.0.1";
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
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(port, host, () =>
  console.log(`AFM Dashboard: http://${host}:${port}/web/`),
);
