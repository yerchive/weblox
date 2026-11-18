# WebBlox

Host-side launcher for Roblox's **official web client** — the `WebClientApp`
Emscripten build that Roblox itself ships at
`setup.rbxcdn.com/webclient/<version>-RobloxWebClient/`. This repo contains none
of Roblox's code; everything engine-related is fetched from Roblox's own CDN at
deploy time, and only the glue (loader page, network bridge, launcher,
integration) lives here.

> **Caveat**: driving the web client from your own host page is against the
> Roblox Terms of Use ("unauthorized clients"). Accounts that use unofficial
> clients can be moderated. Weigh that before deploying, and never commit real
> session tokens.

## Architecture

```
┌──────────────────────────── top-level tab (COOP + COEP) ─────────────────────────┐
│  index.html                                                                      │
│    ├─ wasm-loader.js   sets __wasmLoaderContext{engineBase,channel,server},      │
│    │                   then injects vendor/engine/WasmPlayer.js                  │
│    ├─ launcher.js      no placeId? → omni-search / paste-link launcher           │
│    ├─ bridge.js        epoxy transport ↔ wisp, cookie jar (localStorage),        │
│    │                   Scramjet session pickup, join quirks, pinned flags        │
│    └─ sw.js            intercepts fetch/XHR to *.roblox.com / *.rbxcdn.com and   │
│                        forwards to bridge.js; stamps synthetic                   │
│                        CORP:cross-origin + ACAO/ACAC/expose-headers responses    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Engine traffic** (`*.roblox.com`, `*.rbxcdn.com`) is caught by `sw.js` and
  proxied over wisp with epoxy (TLS terminates in the browser). Cookies live in
  a localStorage jar, because epoxy has no browser cookie store and the page
  origin is not roblox.com.
- **Game traffic** (WebTransport to `*.qdmux.roblox.com`) bypasses service
  workers by design and connects **directly** — do not try to route it through
  wisp.
- **Flags** are pinned next to the engine: `bridge.js` answers
  `clientsettingscdn.roblox.com/v2/settings/application/*` from
  `vendor/flags/<App>.json` and `client-version` from `vendor/version.json`, so
  a live flag push can't break the pinned build.
- **Isolation**: the engine runs pthreads on a shared `WebAssembly.Memory`, so
  the player must be a top-level document with COOP `same-origin` and COEP
  `require-corp`. Never embed it in an iframe; open it in its own tab.

## Deploy

Requires Node ≥ 18 and a real TLS origin (SecureContext + SharedArrayBuffer),
plus a [wisp](https://github.com/MercuryWorkshop/wisp-protocol) server.

```bash
npm run vendor        # fetch engine + ~2900 content files + pinned flags + epoxy bundle
npm start             # http://127.0.0.1:4444 (PORT=... HOST=... to override)
npm test              # fsindex decoder + server header/isolation smoke tests
```

`npm run vendor` hits, in order:

1. `clientsettings.roblox.com/v2/client-version/WebClientApp` → `clientVersionUpload`
2. `clientsettingscdn.roblox.com/v2/settings/application/<App>` → `vendor/flags/`
3. `setup.rbxcdn.com/webclient/<versionUpload>-RobloxWebClient/` —
   `WasmPlayer.js`, `WebClient.js`, `WebClient.wasm`, `audio-processor-fast.js`,
   `WebClient.fsindex.txt` and every content file `fsindex` lists (the manifest
   is prefix-compressed `prefixLen\tsuffix\tsize`; decoded paths sit 1:1 on the
   CDN base — verified)
4. `cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@3.0.1/dist/index.js` →
   `vendor/epoxy/index.js` (epoxy-tunnel is deprecated; this is its successor)

Rerun `npm run vendor` to move to a newer engine — it clears stale files
automatically, re-pins flags, and verifies downloaded sizes.

The **wisp server** is configured in `player/config.js` (`wispUrl`), overridable
per session with `?wisp=` or `localStorage["webblox-wisp"]`.

## Joining experiences

- Sign in via the app's Scramjet browser (email one-time code + audio CAPTCHA).
  The bridge reads `.ROBLOSECURITY` from Scramjet's IndexedDB
  (`__scramjet_controller` → store `state` → key `cookies`, entries keyed
  `domain@path@name`) on the same origin. Without a session, joins fail with
  **524 "Not authorized"**.
- `?placeId=` drives the engine; with no place id the launcher shows instead
  (omni-search through the bridge, or paste any `roblox.com/games/…` link).
- Join quirks implemented in `bridge.js`:
  - `POST gamejoin.roblox.com` gets `rbx-user-agent: Roblox/Darwin`
  - other roblox.com requests: `rbx-user-agent` "Roblox/Web … Desktop" →
    `Roblox/WinInet`, `Browser/…` stripped
  - `/v1/join-game` with a `gameId` in the body is rewritten to
    `/v1/join-game-instance`
  - if the join response omits `joinScript.gameFqdn`, it is derived per the
    working-deployment formula:
    `<token hex>-<MachineAddress hex>-<NetStackPort hex>.<UdmuxEndpoints[0].Address last-octet+1 hex>.qdmux.roblox.com`
- Joining a specific server by id is not wired into the engine startup path;
  the join rewriter above is the hook if the engine ever surfaces it.

## Scramjet integration

`integration/roblox-launch-plugin.js` hooks the proxied roblox.com frames and
converts desktop-app handoffs into player tabs:

- `roblox-player:` / `roblox://` URIs arriving via hidden-iframe `src` (property
  or `setAttribute`), `window.open`, or anchors
- `/games/start?placeId=` navigations (link / `window.open`)
- friend "Join" (`launchmode=friend` + `userId`) resolves the user's presence
  via `presence.roblox.com/v1/presence/users`, then opens the player on
  that place

Register it alongside Scramjet's own scripts in the host app:

```html
<script src="/scramjet/integration/roblox-launch-plugin.js" defer></script>
```

`window.__webbloxPlayerUrl` (default `/player/index.html`) controls where the
player tab opens from.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `SharedArrayBuffer is not defined` / pthread worker crash | Page not cross-origin isolated — check COOP/COEP headers and that it's a top-level tab over TLS |
| Engine logs `no startup place id; exiting` | Played without `?placeId=` (or a teleport dropped it) |
| HTTP 524 "Not authorized" on join | No `.ROBLOSECURITY` in the cookie jar — sign in via the app browser first |
| `failed to load /vendor/epoxy/index.js` | `npm run vendor` not run, or `vendorPrefix` wrong |
| Stuck at "Downloading… 0 MB" | `vendor/engine/WebClient.wasm` missing (run vendor script) or wrong content-type |
| World loads but no data | Wisp server offline, or the network blocks WebTransport (game traffic never uses wisp) |
