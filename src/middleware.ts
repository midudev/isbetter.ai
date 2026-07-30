import { defineMiddleware } from "astro:middleware";
import { SITE_CSP } from "./scripts/preview-security";

/**
 * Apply site security headers on every Astro/Worker response.
 * public/_headers covers static assets on Cloudflare Pages; this covers SSR
 * responses and local `astro dev` (where _headers are not applied).
 */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", SITE_CSP);
  }
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("X-Frame-Options")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }
  if (!headers.has("Permissions-Policy")) {
    headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
