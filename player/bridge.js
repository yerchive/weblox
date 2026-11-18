/**
 * Page side of the WebBlox network bridge.
 *
 * - registers sw.js and passes it a MessageChannel
 * - loads the epoxy transport (bundled under vendor/epoxy/) and points it at a wisp server
 * - fulfils proxied requests and stamps browser cookies on them (jar in localStorage:
 *   epoxy does not get the browser's cookie store, and roblox.com is a different origin)
 * - seeds .ROBLOSECURITY from Scramjet's IndexedDB cookie dump when running on the
 *   same origin as the host app's Scramjet browser
 * - applies the join quirks the web client expects:
 *     gamejoin.roblox.com  -> rbx-user-agent: Roblox/Darwin
 *     other *.roblox.com    -> rbx-user-agent "Roblox/Web ... Desktop" => "Roblox/WinInet", drop "Browser/..."
 *     /v1/join-game + body {"gameId": ...} -> /v1/join-game-instance
 *     join response        -> derive joinScript.gameFqdn when the server omits it
 * - serves pinned client settings/flags from vendor/ so a flag push can't break
 *   the pinned engine build
 */

(() => {
  const CONFIG = window.__webbloxConfig ?? {};
  const VENDOR_PREFIX = CONFIG.vendorPrefix ?? "/vendor";

  const SW_SCOPE = new URL(".", window.location).href;
  const REGEX = {
    clientVersion: /^\/v2\/client-version\/WebClientApp$/,
    appSettings: /^\/v2\/settings\/application\/([^/]+?)(?:\/bucket\/(.+))?$/,
    gameJoin: /(^|\.)gamejoin\.roblox\.com$/,
    joinGame: /(^|\.)gamejoin\.roblox\.com$/,
    apiHost: /(^|\.)(roblox\.com|robloxlabs\.com)$/,
  };

  const CONFIG_APPS = ["WebClientApp", "WindowsWebClientApp", "MacWebClientApp", "iOSWebClientApp", "AndroidWebClientApp"];

  class CookieJar {
    static STORAGE_KEY = "webblox-cookies";

    constructor() {
      this.cookies = new Map();
      try {
        const raw = localStorage.getItem(CookieJar.STORAGE_KEY);
        if (raw) {
          this.cookies = new Map(Object.entries(JSON.parse(raw)));
        }
      } catch (err) {
        console.warn("[webblox] could not read cookie jar:", err);
      }
    }

    persist() {
      try {
        localStorage.setItem(CookieJar.STORAGE_KEY, JSON.stringify(Object.fromEntries(this.cookies)));
      } catch (err) {
        console.warn("[webblox] could not persist cookie jar:", err);
      }
    }

    static key({ domain, path, name }) {
      return `${domain.toLowerCase()}@${path}@${name}`;
    }

    set(cookie) {
      const domain = cookie.domain ?? "unknown";
      const path = cookie.path ?? "/";
      const name = cookie.name;
      this.cookies.set(CookieJar.key({ domain, path, name }), { ...cookie, domain, path, name });
      this.persist();
    }

    forUrl(url) {
      const host = url.hostname.toLowerCase();
      const out = [];
      for (const key of this.cookies.keys()) {
        const [domain, path, name] = key.split("@");
        const domainMatch = host === domain || host.endsWith(`.${domain}`);
        const pathMatch = url.pathname.startsWith(path) || path === "/";
        if (domainMatch && pathMatch) out.push([name, this.cookies.get(key).value]);
      }
      return out;
    }

    get(name, domainSuffix) {
      for (const key of this.cookies.keys()) {
        const [domain, , cookieName] = key.split("@");
        if (cookieName === name && domain.endsWith(domainSuffix)) return this.cookies.get(key).value;
      }
      return null;
    }

    absorbSetCookie(setCookieValue, urlHost) {
      const parts = String(setCookieValue).split(";");
      const [pair, ...attrs] = parts;
      const eq = pair.indexOf("=");
      if (eq <= 0) return;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = urlHost;
      let path = "/";
      let expires = null;
      for (const attr of attrs) {
        const [attrName, attrValue = ""] = attr.trim().split(/=(.*)/s, 2);
        const lower = attrName.trim().toLowerCase();
        if (lower === "domain") domain = attrValue.replace(/^\./, "") || urlHost;
        else if (lower === "path") path = attrValue || "/";
        else if (lower === "expires") expires = new Date(attrValue).getTime() || null;
      }
      if (expires && expires <= Date.now()) {
        this.cookies.delete(CookieJar.key({ domain, path, name }));
        this.persist();
        return;
      }
      this.set({ name, value, domain, path });
    }
  }

  async function readScramjetSession() {
    const DATABASE = "__scramjet_controller";
    if (!indexedDB.databases) return null;
    const known = await indexedDB.databases().catch(() => null);
    if (!known?.some((db) => db.name === DATABASE)) return null;

    return new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DATABASE);
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction("state", "readonly");
          const get = tx.objectStore("state").get("cookies");
          get.onsuccess = () => {
            db.close();
            resolve(get.result ?? null);
          };
          get.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  }

  function cookiesFromScramjet(dump) {
    const found = [];
    let raw = dump;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return found;
      }
    }
    if (!raw || typeof raw !== "object") return found;

    for (const [key, entry] of Object.entries(raw)) {
      if (!key.toLowerCase().endsWith(".roblosecurity")) continue;
      const value = typeof entry === "string" ? entry : entry?.value;
      const domain = entry?.domain ?? (key.split("@")[0] || "www.roblox.com");
      if (typeof value === "string" && value) {
        found.push({ name: ".ROBLOSECURITY", value, domain, path: entry?.path ?? "/" });
      }
    }
    return found;
  }

  function hexIp(address) {
    return String(address)
      .split(".")
      .filter((part) => part !== "")
      .map((part) => (parseInt(part, 10) & 0xff).toString(16).padStart(2, "0"))
      .join("");
  }

  function deriveGameFqdn(joinScript) {
    try {
      const tokenHex = String(joinScript.token ?? "").replace(/[^0-9a-fA-F]/g, "");
      const machineAddressHex = hexIp(joinScript.MachineAddress ?? joinScript.machineAddress ?? "");
      const portHex = Number(joinScript.NetStackPort ?? joinScript.port ?? 0)
        .toString(16)
        .padStart(4, "0");
      const endpoints = joinScript.UdmuxEndpoints ?? joinScript.udmuxEndpoints ?? [];
      if (!tokenHex || !machineAddressHex || !portHex || !endpoints.length) return null;
      const addressList = endpoints[0].Address ?? endpoints[0].address ?? "";
      const octets = String(addressList).split(".").map((o) => parseInt(o, 10) & 0xff);
      if (octets.length !== 4) return null;
      octets[3] = (octets[3] + 1) & 0xff;
      const upstreamHex = octets.map((o) => o.toString(16).padStart(2, "0")).join("");
      return `${tokenHex}-${machineAddressHex}-${portHex}.${upstreamHex}.qdmux.roblox.com`;
    } catch {
      return null;
    }
  }

  function isGameJoinRequest(method, url) {
    return method === "POST" && REGEX.gameJoin.test(url.hostname);
  }

  function applyRequestQuirks(method, url, headers) {
    const set = (name, value) => {
      const existing = headers.find(([headerName]) => headerName.toLowerCase() === name);
      if (existing) existing[1] = value;
      else headers.push([name, value]);
    };

    if (REGEX.apiHost.test(url.hostname)) {
      const uaIndex = headers.findIndex(([headerName]) => headerName.toLowerCase() === "rbx-user-agent");
      if (uaIndex !== -1) {
        let ua = headers[uaIndex][1];
        const isJoin = method === "POST" && REGEX.gameJoin.test(url.hostname);
        if (isJoin) {
          ua = "Roblox/Darwin";
        } else {
          ua = ua.replace(/\s*Browser\/[^ ;,]+/g, "");
          if (/Roblox\/Web.*Desktop/.test(ua)) ua = "Roblox/WinInet";
        }
        headers[uaIndex][1] = ua.trim();
      }
    }
  }

  function applyJoinResponseQuirk(buffer) {
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      return null;
    }
    const joinScript = parsed?.joinScript;
    if (!joinScript || typeof joinScript !== "object") return null;
    if (joinScript.gameFqdn) return null;
    const fqdn = deriveGameFqdn(joinScript);
    if (!fqdn) return null;
    joinScript.gameFqdn = fqdn;
    console.info("[webblox] derived gameFqdn from join response");
    return { ...parsed, joinScript };
  }

  function synthHeadersFromUpstream(headers) {
    const out = [];
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (lower === "content-encoding" || lower === "transfer-encoding" || lower === "set-cookie") continue;
      out.push([lower, value]);
    }
    return out;
  }

  class Bridge {
    constructor() {
      this.transport = null;
      this.jar = new CookieJar();
      this.flagsCache = new Map();
      this.versionCache = null;
      this.ready = this.init();
    }

    async init() {
      if (!window.isSecureContext || !window.crossOriginIsolated) {
        console.error("[webblox] page is not cross-origin isolated. Serve with COOP: same-origin + COEP: require-corp as a top-level document.");
      }

      await this.registerServiceWorker();
      await this.loadScramjetSession();

      await this.injectScript(`${VENDOR_PREFIX}/epoxy/index.js`);
      const namespace = window.EpoxyTransport?.default ?? window.EpoxyTransport;
      const wispUrl = new URLSearchParams(window.location.search).get("wisp")
        ?? localStorage.getItem("webblox-wisp")
        ?? CONFIG.wispUrl;
      if (!namespace) throw new Error("epoxy transport bundle did not expose a namespace");
      if (!wispUrl) throw new Error("no wisp server configured (set window.__webbloxConfig.wispUrl)");

      this.transport = new namespace({ wisp: wispUrl, udp_extension_required: false });
      await this.transport.init();
      console.log(`[webblox] epoxy ready (wisp: ${wispUrl})`);
    }

    async registerServiceWorker() {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: SW_SCOPE });
      const client = registration.active
        ?? registration.installing
        ?? registration.waiting
        ?? (await navigator.serviceWorker.ready).active;
      await new Promise((resolve) => {
        if (client.state === "activated") resolve();
        else client.addEventListener("statechange", () => client.state === "activated" && resolve());
      });

      const channel = new MessageChannel();
      this.channel = channel.port1;
      this.channel.start();
      navigator.serviceWorker.controller.postMessage({ type: "webblox-hello" }, [channel.port2]);
      this.channel.onmessage = (event) => this.handleProxiedRequest(event.data);
    }

    async loadScramjetSession() {
      const dump = await readScramjetSession();
      const cookies = cookiesFromScramjet(dump);
      if (cookies.length) {
        for (const cookie of cookies) this.jar.set(cookie);
        console.log(`[webblox] loaded ${cookies.length} session cookie(s) from Scramjet storage`);
      } else {
        console.warn("[webblox] no .ROBLOSECURITY found; joins will fail with 524 (Not authorized) until you sign in");
      }
      this.sessionCache = cookies;
    }

    injectScript(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`failed to load ${src} (did you run scripts/fetch-vendor.mjs?)`));
        document.head.append(script);
      });
    }

    async handleProxiedRequest(message) {
      const { id, method, url, headers = [] } = message;
      if (typeof url !== "string") return;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }

      try {
        const response = await this.dispatch(method, parsed, headers, message.body, id);
        const transfer = response.body?.byteLength ? [response.body] : [];
        this.channel.postMessage(response, transfer);
      } catch (err) {
        console.warn(`[webblox] proxied request failed: ${method} ${url}`, err);
        this.channel.postMessage({
          type: "webblox-response",
          id,
          error: err?.message ?? "upstream failure",
        });
      }
    }

    async dispatch(method, url, headers, body, id) {
      const pinned = await this.tryPinnedSettings(url);
      if (pinned) {
        return {
          type: "webblox-response",
          id,
          status: 200,
          statusText: "OK",
          headers: [["content-type", "application/json"]],
          body: pinned,
        };
      }

      if (/clientsettings/.test(url.hostname) && url.pathname === "/v2/client-version/WebClientApp") {
        return this.localVersionResponse(id);
      }

      const mutableHeaders = headers.map(([name, value]) => [name, value]);
      this.attachCookies(url, mutableHeaders);
      applyRequestQuirks(method, url, mutableHeaders);

      const upstream = await this.transport.request(
        url,
        method,
        body ?? null,
        mutableHeaders,
        undefined,
      );

      const flatHeaders = [
        ...synthHeadersFromUpstream(upstream.headers ?? []),
        ...collectSetCookie(upstream.headers ?? [], this.jar, url),
      ];

      let responseBody = upstream.body ?? null;
      if (responseBody instanceof ReadableStream) {
        responseBody = await new Response(responseBody).arrayBuffer();
      }

      if (isGameJoinRequest(method, url) && responseBody) {
        const joined = applyJoinResponseQuirk(responseBody);
        if (joined) {
          const encoded = new TextEncoder().encode(JSON.stringify(joined));
          responseBody = encoded.buffer;
        }
      }

      return {
        status: upstream.status ?? 502,
        statusText: upstream.statusText ?? "",
        headers: flatHeaders,
        body: responseBody,
      };
    }

    async tryPinnedSettings(url) {
      const match = url.pathname.match(REGEX.appSettings);
      if (!match || !/clientsettings/.test(url.hostname)) return null;
      const app = match[1];
      if (!CONFIG_APPS.includes(app)) return null;

      let body = this.flagsCache.get(app);
      if (!body) {
        const res = await fetch(`${VENDOR_PREFIX}/flags/${app}.json`);
        body = await res.arrayBuffer();
        this.flagsCache.set(app, body);
      }
      return body;
    }

    async localVersionResponse(id) {
      if (!this.versionCache) {
        const res = await fetch(`${VENDOR_PREFIX}/version.json`);
        const json = await res.json();
        this.versionCache = {
          version: json.version,
          clientVersionUpload: json.clientVersionUpload,
          bootstrapperVersion: "",
        };
      }
      return {
        type: "webblox-response",
        id,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(JSON.stringify(this.versionCache)).buffer,
      };
    }

    attachCookies(url, headers) {
      const pairs = this.jar.forUrl(url);
      if (!pairs.length) return;
      const serialized = pairs.map(([name, value]) => `${name}=${value}`).join("; ");
      const existing = headers.find(([name]) => name.toLowerCase() === "cookie");
      if (existing) existing[1] = `${existing[1]}; ${serialized}`;
      else headers.push(["Cookie", serialized]);
    }
  }

  function collectSetCookie(upstreamHeaders, jar, url) {
    const out = [];
    for (const [name, value] of upstreamHeaders) {
      if (name.toLowerCase() === "set-cookie") {
        for (const part of String(value).split(/,(?=\s*[\w$-]+\s*=\s*\S)/)) {
          jar.absorbSetCookie(part.trim(), url.hostname);
        }
      }
    }
    return out;
  }

  window.__webbloxBridge = new Bridge();

  const openTabButton = document.getElementById("loading-cancel");
  openTabButton?.addEventListener("click", () => window.close());
})();
