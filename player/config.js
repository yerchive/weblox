/**
 * Deployment knobs. Override per environment; defaults work for a root-path deploy.
 * WISP_URL may also be overridden at runtime with ?wisp= or localStorage("webblox-wisp").
 */
window.__webbloxConfig = {
  // Wisp server the bridge tunnels proxied requests through ("wss://host/" preferred; may also be "/wisp/" if your host terminates TLS).
  wispUrl: "wss://wisp.mercurywork.shop/",
  // Path where scripts/fetch-vendor.mjs placed the engine (must be same-origin as the player page).
  vendorPrefix: "/vendor",
};
