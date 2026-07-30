import type { APIRoute } from "astro";
import { PREVIEW_CSP } from "../scripts/preview-security";

export const prerender = false;

/**
 * Bootstrap document for sandboxed preview iframes.
 *
 * Loaded over HTTP so the frame gets PREVIEW_CSP from response headers and
 * does NOT inherit the parent page CSP (unlike srcdoc/blob). The parent then
 * postMessages the hardened demo HTML; we document.write it into place.
 */
const BOOTSTRAP = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview</title>
<style>html,body{margin:0;height:100%;background:#080a08}</style>
</head>
<body>
<script>
(function () {
  function accept(data) {
    return data && data.__ab === "preview-html" && typeof data.html === "string";
  }
  addEventListener("message", function (event) {
    if (!accept(event.data)) return;
    document.open();
    document.write(event.data.html);
    document.close();
  });
  parent.postMessage({ __ab: "preview-ready" }, "*");
})();
</script>
</body>
</html>`;

export const GET: APIRoute = () =>
  new Response(BOOTSTRAP, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PREVIEW_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
