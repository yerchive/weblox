/**
 * WasmLoader replacement.
 *
 * Roblox's own WasmLoader.js just resolves the engine base and bootstraps
 * WasmPlayer.js; we do the same with our vendored copy and only after the
 * network bridge is ready (so the engine's very first requests are already
 * intercepted).
 */

(() => {
  const CONFIG = window.__webbloxConfig ?? {};
  const VENDOR_PREFIX = CONFIG.vendorPrefix ?? "/vendor";

  function engineBase() {
    // version.json pins engineBase to the versions directory the vendor script filled.
    return `${VENDOR_PREFIX}/engine/`;
  }

  async function startEngine() {
    const loaderContextReady = window.__webbloxBridge?.ready?.then(() => {
      window.__wasmLoaderContext = {
        engineBase: engineBase(),
        channel: null,
        server: "prod",
      };
    });
    if (!loaderContextReady) throw new Error("bridge unavailable");

    await loaderContextReady;

    const params = new URLSearchParams(window.location.search);
    const placeId = parseInt(params.get("placeId") ?? "", 10);
    if (!Number.isInteger(placeId) || placeId <= 0) {
      // No startup place id — the engine would log "no startup place id; exiting".
      document.getElementById("launcher")?.removeAttribute("hidden");
      return;
    }

    document.getElementById("loading-overlay")?.removeAttribute("hidden");

    const script = document.createElement("script");
    script.src = `${engineBase()}WasmPlayer.js`;
    script.onerror = () => {
      document.getElementById("status") &&
        (document.getElementById("status").textContent = "Failed to load the Roblox engine. Did you run `npm run vendor`?");
    };
    document.body.append(script);
  }

  window.addEventListener("DOMContentLoaded", () => {
    startEngine().catch((err) => {
      console.error("[webblox] engine bootstrap failed:", err);
      const status = document.getElementById("loading-error-message");
      if (status) status.textContent = String(err?.message ?? err);
      document.getElementById("loading-overlay")?.removeAttribute("hidden");
      document.querySelector(".loading-error-panel")?.removeAttribute("hidden");
    });
  });
})();
