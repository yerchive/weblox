/**
 * Static server with the isolation headers the Wasm engine needs.
 * The page runs pthreads on a shared WebAssembly.Memory, so it must be
 * served top-level with COOP + COEP (and never be embedded in an iframe).
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 4444);
const HOST = process.env.HOST || "127.0.0.1";

const PLAYER_DIR = join(ROOT, "player");
const VENDOR_DIR = join(ROOT, "vendor");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".dds": "image/vnd-ms.dds",
  ".rbxm": "application/octet-stream",
  ".rbxl": "application/octet-stream",
  ".mesh": "application/octet-stream",
};

const NO_CACHE = new Set(["/sw.js", "/config.js", "/index.html"]);

function isolated(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function serveFile(res, absolutePath, cacheKey) {
  const stat = statSync(absolutePath);
  res.statusCode = 200;
  isolated(res);
  res.setHeader("Content-Type", MIME[extname(absolutePath).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", NO_CACHE.has(cacheKey) ? "no-cache" : "public, max-age=3600");
  createReadStream(absolutePath).pipe(res);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/") pathname = "/index.html";
    if (pathname.endsWith("/")) pathname += "index.html";

    let fileRoot;
    if (pathname.startsWith("/vendor/")) {
      pathname = pathname.slice("/vendor".length);
      fileRoot = VENDOR_DIR;
    } else {
      fileRoot = PLAYER_DIR;
    }

    const absolute = normalize(join(fileRoot, pathname));
    if (!absolute.startsWith(fileRoot)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    serveFile(res, absolute, pathname);
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err?.message ?? err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[webblox] http://${HOST}:${PORT}`);
});
