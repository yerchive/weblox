import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(ROOT, "..", "player"), { recursive: true });

const child = spawn(process.execPath, [join(ROOT, "..", "server.mjs")], {
  env: { ...process.env, PORT: "47147", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const VENDOR_ENGINE = join(ROOT, "..", "vendor", "engine");
mkdirSync(VENDOR_ENGINE, { recursive: true });
writeFileSync(join(VENDOR_ENGINE, "WebClient.wasm"), "dummy");
writeFileSync(join(VENDOR_ENGINE, "WasmPlayer.js"), "dummy");

const BASE = "http://127.0.0.1:47147";
async function until(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await predicate();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`timeout: ${output}`);
}

try {
  const index = await until(() => fetch(`${BASE}/`).then((r) => r.text()));
  assert.match(index, /id="canvas"/);
  assert.match(index, /id="loading-overlay"/);

  for (const id of ["input-container", "input-textarea", "input-input", "server", "proxyenabled", "loading-cancel", "loading-error-leave", "loading-experience-title", "loading-experience-creator", "status"]) {
    assert.match(index, new RegExp(`id="${id}"`), `missing DOM id ${id}`);
  }
  assert.match(index, /class="loading-error-panel"/);

  const sw = await fetch(`${BASE}/sw.js`);
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers.get("cache-control"), /no-cache/);

  const engine = await fetch(`${BASE}/vendor/engine/WebClient.wasm`);
  assert.strictEqual(engine.status, 200);
  assert.strictEqual(engine.headers.get("content-type"), "application/wasm");

  const engineJs = await fetch(`${BASE}/vendor/engine/WasmPlayer.js`);
  assert.strictEqual(engineJs.status, 200);
  assert.strictEqual(engineJs.headers.get("content-type"), "text/javascript; charset=utf-8");

  const headers = (await fetch(`${BASE}/`)).headers;
  assert.strictEqual(headers.get("cross-origin-opener-policy"), "same-origin");
  assert.strictEqual(headers.get("cross-origin-embedder-policy"), "require-corp");

  const traversal = await fetch(`${BASE}/vendor/..%2f..%2fpackage.json`);
  assert.ok(traversal.status === 403 || traversal.status === 404, `traversal guard returned ${traversal.status}`);

  const missing = await fetch(`${BASE}/vendor/engine/definitely-missing.bin`);
  assert.strictEqual(missing.status, 404);

  console.log("server smoke test: OK");
} finally {
  child.kill("SIGTERM");
  rmSync(join(ROOT, "..", "vendor"), { recursive: true, force: true });
}
