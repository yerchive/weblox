/**
 * Launcher: game search via omni-search plus game-link parsing.
 * Runs only when the page has no ?placeId= (otherwise the engine boots directly).
 * All requests go through the service worker bridge, same as engine traffic.
 */

(() => {
  const form = document.getElementById("launcher-form");
  const query = document.getElementById("launcher-query");
  const results = document.getElementById("launcher-results");
  const errorBox = document.getElementById("launcher-error");
  const sessionBox = document.getElementById("launcher-session");

  function hasPlaceId() {
    const placeId = parseInt(new URLSearchParams(window.location.search).get("placeId") ?? "", 10);
    return Number.isInteger(placeId) && placeId > 0;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function extractPlaceId(input) {
    const text = String(input ?? "").trim();
    if (/^\d+$/.test(text)) return text;
    let match = text.match(/roblox\.com\/games\/(\d+)/i);
    if (match) return match[1];
    match = text.match(/[?&]placeId=(\d+)/i);
    if (match) return match[1];
    return null;
  }

  function join(placeIdText) {
    const url = new URL(window.location.href);
    url.searchParams.set("placeId", placeIdText);
    window.location.href = url.href;
  }

  async function bridgeFetch(url, init) {
    if (!window.__webbloxBridge?.transport) throw new Error("network bridge not ready");
    const res = await fetch(url, { ...init, credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url, window.location).pathname}`);
    return res.json();
  }

  async function search(term) {
    const endpoint = new URL("https://apis.roblox.com/search-api/omni-search");
    endpoint.searchParams.set("searchQuery", term);
    endpoint.searchParams.set("pageToken", "");
    endpoint.searchParams.set("sessionId", crypto.randomUUID?.() ?? String(Date.now()));
    endpoint.searchParams.set("pageType", "all");
    return bridgeFetch(endpoint.href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageType: "all" }),
    });
  }

  function renderSearch(payload) {
    results.textContent = "";
    const games =
      payload?.searchResults?.find((group) => group.contentGroupType === "Game")?.contents
      ?? payload?.contents?.filter((entry) => entry.contentGroupType === "Game").flatMap((g) => g.contents)
      ?? [];
    for (const game of games.slice(0, 12)) {
      const placeId = game.universeId ?? game.universe?.placeId ?? game.placeId;
      const item = document.createElement("li");
      const image = document.createElement("img");
      image.loading = "lazy";
      image.src = game.thumbnailUrl ?? game.imageUrl ?? "";
      const meta = document.createElement("div");
      meta.className = "result-meta";
      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = game.name ?? "Untitled";
      const sub = document.createElement("span");
      sub.className = "result-sub";
      sub.textContent = game.playerCount != null ? `${game.playerCount} playing` : game.creatorName ?? "";
      meta.append(name, sub);
      item.append(image, meta);
      item.addEventListener("click", () => join(placeId));
      results.append(item);
    }
    if (!results.children.length) showError("No matching experiences found.");
  }

  function describeSession() {
    const session = window.__webbloxBridge?.sessionCache ?? [];
    if (!session.length) {
      sessionBox.textContent = "Not signed in - sign in through the app browser first, or joins will fail with error 524.";
    } else {
      sessionBox.textContent = "Signed in via the app browser session.";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    if (hasPlaceId()) return;
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      showError("");
      const value = query?.value ?? "";
      const placeId = extractPlaceId(value);
      if (placeId) {
        join(placeId);
        return;
      }
      if (!value.trim()) return;
      results.textContent = "";
      search(value.trim()).then(renderSearch).catch((err) => showError(`Search failed: ${err.message}`));
    });
    describeSession();
  });
})();
