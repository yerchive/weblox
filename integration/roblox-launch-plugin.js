/**
 * Scramjet frame plugin: roblox.com pages keep trying to hand the user off to
 * the desktop app (roblox-player: / roblox:// protocol URIs, or
 * /games/start?placeId=... top-level navigations). Inside the client-side
 * proxy those handoffs are dead ends. This plugin catches them and opens the
 * WebBlox player tab instead.
 *
 * Wire it up next to the Scramjet controller bootstrap:
 *   <script src="%SCRAMJET%/../roblox-launch-plugin.js" defer></script>
 * (exact path depends on how your app bundles scramjet's fake-host files)
 *
 * The player page itself must be opened as a top-level tab (COOP/COEP), never
 * inside the proxied frame.
 */

(() => {
  const PLAYER_URL = window.__webbloxPlayerUrl ?? "/player/index.html";

  const PROTOCOL_RE = /^roblox(-player)?:\/\//i;
  const START_RE = /\/games\/start(?:\/|\?|$)/i;

  function paramsFromProtocolUri(uri) {
    const params = new URLSearchParams(String(uri).replace(/^(roblox-player|roblox):\/\//i, ""));
    const placeId = params.get("placeId");
    const out = { placeId: placeId ? String(parseInt(placeId, 10)) : null, gameId: params.get("gameId"), userId: null };
    if (!out.placeId && /launchmode=friend/i.test(String(uri))) {
      const userId = params.get("userId");
      if (userId) out.userId = String(parseInt(userId, 10));
    }
    return out;
  }

  function paramsFromStartPath(url) {
    try {
      const parsed = new URL(url, location.href);
      if (!START_RE.test(parsed.pathname) && !/games\/start\.html$/i.test(parsed.pathname)) return null;
      const placeId = parsed.searchParams.get("placeId");
      return { placeId: placeId ? String(parseInt(placeId, 10)) : null, gameId: parsed.searchParams.get("gameId"), userId: null };
    } catch {
      return null;
    }
  }

  function openInPlayer(params) {
    if (!params?.placeId) return false;
    const url = new URL(PLAYER_URL, window.__scramjet?.href ?? location.href);
    url.searchParams.set("placeId", params.placeId);
    window.open(url.href, "_blank", "noopener");
    return true;
  }

  async function resolveFollowLaunch(userId) {
    try {
      const res = await fetch("https://presence.roblox.com/v1/presence/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: [Number(userId)] }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const presence = data?.userPresences?.[0];
      if (!presence?.placeId) return null;
      return { placeId: String(presence.placeId), gameId: presence.gameId ?? null };
    } catch {
      return null;
    }
  }

  function isLaunchNavigation(value) {
    if (typeof value !== "string") return false;
    if (PROTOCOL_RE.test(value.trim())) return paramsFromProtocolUri(value.trim());
    return paramsFromStartPath(value);
  }

  const iframeDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
  if (iframeDescriptor?.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      set(value) {
        const params = isLaunchNavigation(value);
        if (params) {
          handleIframeLaunch(params);
          return;
        }
        iframeDescriptor.set.call(this, value);
      },
      get() {
        return iframeDescriptor.get.call(this);
      },
      configurable: true,
    });

    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this.tagName === "IFRAME" && /^src$/i.test(name)) {
        const params = isLaunchNavigation(value);
        if (params) {
          handleIframeLaunch(params);
          return;
        }
      }
      setAttribute.call(this, name, value);
    };
  }

  let hiddenLauncherFrame = null;
  function handleIframeLaunch(params) {
    if (params.userId && !params.placeId) {
      resolveFollowLaunch(params.userId).then((resolved) => openInPlayer(resolved));
      return;
    }
    openInPlayer(params);
  }

  function keepHiddenLauncher() {
    if (hiddenLauncherFrame) return null;
    hiddenLauncherFrame = document.createElement("iframe");
    hiddenLauncherFrame.style.display = "none";
    document.body?.append(hiddenLauncherFrame);
    return hiddenLauncherFrame;
  }

  const originalWindowOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    const params = isLaunchNavigation(url);
    if (params) {
      keepHiddenLauncher();
      handleIframeLaunch(params);
      return null;
    }
    return originalWindowOpen(url, target, features);
  };

  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor) return;
      const params = isLaunchNavigation(anchor.getAttribute("href"));
      if (!params) return;
      event.preventDefault();
      event.stopPropagation();
      handleIframeLaunch(params);
    },
    { capture: true },
  );

  window.addEventListener("beforeunload", () => {
    if (hiddenLauncherFrame) {
      hiddenLauncherFrame.remove();
      hiddenLauncherFrame = null;
    }
  });

  window.__webbloxLaunch = handleIframeLaunch;
})();
