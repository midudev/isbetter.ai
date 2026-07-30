/* =========================================================================
   Preview / site CSP constants shared by the client, /preview-frame, and
   middleware. Keep public/_headers in sync with SITE_CSP.
   ========================================================================= */

/**
 * CSP for untrusted preview documents. Interactive demos may load CDN
 * scripts (three.js, etc.) over https/http. Form exfil, nested frames,
 * plugins, and base-tag hijacks stay blocked. Isolation from parent
 * localStorage comes from sandbox without allow-same-origin — not from CSP.
 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https: http: blob:",
  "style-src 'unsafe-inline' https: http:",
  "img-src data: blob: https: http:",
  "font-src data: https: http:",
  "media-src data: blob: https: http:",
  "connect-src https: http: ws: wss: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "worker-src blob: https: http:",
  "manifest-src 'none'",
].join("; ");

/**
 * Site-wide CSP. Preview iframes used to be srcdoc (inherit + intersect this
 * policy), so SITE_CSP must remain a superset of PREVIEW_CSP script/style/
 * asset sources. In-app previews now load /preview-frame over HTTP with its
 * own PREVIEW_CSP header, but open-in-tab and any leftover srcdoc still
 * intersect with this policy.
 */
export const SITE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' https: http: ws: wss: blob:",
  "font-src 'self' data: https: http:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "frame-src 'self' blob:",
  "img-src 'self' data: blob: https: http:",
  "manifest-src 'self'",
  "media-src 'self' data: blob: https: http:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https: http: blob:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "worker-src 'self' blob: https: http:",
].join("; ");

/** Same-origin bootstrap that receives preview HTML via postMessage. */
export const PREVIEW_FRAME_PATH = "/preview-frame";

/**
 * Tightest sandbox that still allows interactive demos.
 * MUST stay exactly "allow-scripts" — never add allow-same-origin (that would
 * let the preview share the parent origin and read localStorage / API keys).
 */
export const PREVIEW_SANDBOX = "allow-scripts";

/** Deny browser/device capabilities that interactive demos do not need. */
export const PREVIEW_ALLOW = [
  "accelerometer 'none'",
  "autoplay 'none'",
  "camera 'none'",
  "clipboard-read 'none'",
  "clipboard-write 'none'",
  "display-capture 'none'",
  "fullscreen 'none'",
  "geolocation 'none'",
  "gyroscope 'none'",
  "magnetometer 'none'",
  "microphone 'none'",
  "payment 'none'",
  "publickey-credentials-get 'none'",
  "usb 'none'",
  "web-share 'none'",
  "xr-spatial-tracking 'none'",
].join("; ");
