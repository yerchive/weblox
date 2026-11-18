/**
 * Network bridge service worker.
 *
 * The Emscripten engine (page + workers) does all its HTTP via fetch/XHR to
 * *.roblox.com / *.rbxcdn.com. Under COEP=require-corp those requests can't be
 * served by the remote origins (no CORP headers), so this worker catches them
 * and hands each one to the player page over a MessageChannel. The page tunnels
 * the request through wisp/epoxy (TLS ends in the browser) and reflects a
 * synthetic response back; the worker stamps the CORP/CORS headers the
 * isolation context requires before handing it to the engine.
 *
 * Game traffic (WebTransport to *.qdmux.roblox.com) is NOT intercepted:
 * WebTransport connections bypass service workers entirely and go direct.
 */

const TARGET_HOST_SUFFIXES = ["roblox.com", "rbxcdn.com", "robloxlabs.com", "rbx.com"];

const portsByClient = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const port = event.ports?.[0];
  if (!port || event.data?.type !== "webblox-hello") return;
  port.start();
  portsByClient.set(event.source?.id ?? "*", port);
  port.onmessage = (reply) => {
    const pending = pendingRequests.get(reply.data?.id);
    if (pending) {
      pendingRequests.delete(reply.data.id);
      pending(reply.data);
    }
  };
});

self.addEventListener("messageerror", () => {
  portsByClient.clear();
});

const pendingRequests = new Map();
let nextRequestId = 0;

function isSameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch {
    return true;
  }
}

function isProxiedHost(url) {
  const name = url.hostname;
  return TARGET_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function upstreamHeaders(headers, origin) {
  const names = new Set(headers.map(([name]) => name.toLowerCase()));

  names.delete("content-encoding");
  names.delete("transfer-encoding");

  const exposeList = [...names];
  if (!exposeList.includes("x-csrf-token")) exposeList.unshift("x-csrf-token");

  const out = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" || lower === "transfer-encoding") continue;
    out.push([name, value]);
  }
  out.push(["Cross-Origin-Resource-Policy", "cross-origin"]);
  out.push(["Access-Control-Allow-Origin", origin ?? "*"]);
  out.push(["Access-Control-Allow-Credentials", origin ? "true" : "false"]);
  out.push(["Access-Control-Expose-Headers", exposeList.join(", ")]);
  out.push([
    "Vary",
    "Origin",
  ]);
  return out;
}

async function proxyThroughPage(request) {
  const url = new URL(request.url);
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  let port = portsByClient.get(request.clientId ?? "*");
  if (!port) {
    for (const key of [request.clientId, "*"]) {
      if (portsByClient.has(key)) {
        port = portsByClient.get(key);
        break;
      }
    }
  }
  if (!port && clientsList.length) {
    const anyClient = clientsList[0];
    port = portsByClient.get(anyClient.id) ?? portsByClient.get("*");
  }
  if (!port) {
    return new Response(
      JSON.stringify({ errors: [{ code: 0, message: "WebBlox bridge is not connected; reload the player tab." }] }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const id = String(++nextRequestId);
  let body = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.clone().arrayBuffer();
  }

  const headers = [];
  request.headers.forEach((value, name) => {
    if (name.toLowerCase() === "host") return;
    headers.push([name, value]);
  });

  const replyPromise = new Promise((resolve, reject) => {
    pendingRequests.set(id, resolve);
  });

  const transfer = body ? [body] : [];
  port.postMessage({ type: "webblox-request", id, method: request.method, url: request.url, headers, body }, transfer);

  const reply = await Promise.race([
    replyPromise,
    new Promise((resolve) => setTimeout(() => resolve({ type: "webblox-response", id, error: "timeout" }), 60000)),
  ]);
  pendingRequests.delete(id);

  if (reply.error) {
    return new Response(
      JSON.stringify({ errors: [{ code: 0, message: `WebBlox bridge failure: ${reply.error}` }] }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const origin = request.headers.get("origin");
  const responseHeaders = upstreamHeaders(reply.headers ?? [], origin);
  const responseBody = reply.body ?? null;
  if (responseBody) responseHeaders.push(["Content-Length", String(responseBody.byteLength ?? 0)]);

  return new Response(responseBody, { status: reply.status, statusText: reply.statusText, headers: responseHeaders });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode === "navigate") return;
  if (isSameOrigin(request)) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isProxiedHost(url)) return;

  event.respondWith(proxyThroughPage(request));
});
