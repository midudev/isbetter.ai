/* =========================================================================
   Shared helpers used by both the arena (index) and the battle detail route.
   Pure functions + result rendering + history storage. No page-specific state.
   ========================================================================= */
import { modelBrandFor } from "./model-icons";
import { PROVIDERS } from "./providers/registry";
import {
  downsampleMetricSamples,
  type MetricSample,
} from "./metrics";

export {
  MAX_METRIC_SAMPLES,
  downsampleMetricSamples,
  type MetricSample,
} from "./metrics";

/* ------------------------------- DOM queries ----------------------------- */
export const $ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => root.querySelector<T>(selector) as T;
export const $$ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
) => [...root.querySelectorAll<T>(selector)];

/* ------------------------------- formatting ------------------------------ */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export const svg = (id: string, cls = "size-4") =>
  `<svg class="${cls}"><use href="#${id}"></use></svg>`;
export const fmtInt = (n: number) => n.toLocaleString("en-US");
export const fmtDur = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
export const fmtCost = (v: number, known = true) => {
  if (!known) return "—";
  if (!v) return "$0";
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(2)}`;
};
export const fmtRate = (n: number) => (n >= 1 ? `${Math.round(n)}` : n.toFixed(1));
export const estTokens = (s: string) => (s ? Math.max(1, Math.round(s.length / 4)) : 0);

/** Output tokens for throughput/cost: thinking + visible text. */
export const estOutputTokens = (reasoning: string, content: string) =>
  estTokens(`${reasoning}${content}`);

/* ----------------------------- code handling ----------------------------- */
export function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```[\w+-]*[^\S\r\n]*\r?\n?([\s\S]*?)(?:```|$)/g)].map(
    (block) => block[1].trim(),
  );
  let html = blocks.find((b) => /<!doctype html|<html[\s>]/i.test(b));
  if (!html && blocks.length) html = blocks[0];
  if (!html) {
    const start = text.search(/<!doctype html|<html[\s>]/i);
    if (start >= 0) html = text.slice(start).trim();
  }
  return html || "";
}
export function extractAnswer(text: string): string {
  // Drop fenced blocks first, then any unfenced HTML document left behind.
  let answer = text
    .replace(/```[\w+-]*[^\S\r\n]*\r?\n?[\s\S]*?(?:```|$)/g, "")
    .trim();
  const htmlStart = answer.search(/<!doctype html|<html[\s>]/i);
  if (htmlStart >= 0) answer = answer.slice(0, htmlStart).trim();
  if (answer) return answer;
  return extractCode(text) ? "" : text.trim();
}
export function hasIncompleteCodeFence(text: string): boolean {
  return (text.match(/```/g)?.length || 0) % 2 === 1;
}
/* --------------------------- result rendering ---------------------------- */
export interface ResultView {
  id: string;
  key?: string;
  raw: string;
  reasoning?: string;
  code: string;
  codeHtml: string;
}
export type ViewMode = "output" | "code" | "preview";

// The model's chain-of-thought, shown above the answer. While streaming it's
// open with a pulsing "thinking…" label; once done it collapses to "thoughts".
export function thoughtsHTML(reasoning: string, streaming: boolean) {
  if (!streaming && !reasoning) return "";
  const hidden = streaming && !reasoning ? "hidden" : "";
  return `
    <details data-thoughts class="group ${hidden} mb-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)]"${streaming ? " open" : ""}>
      <summary class="flex cursor-pointer select-none list-none items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)] [&::-webkit-details-marker]:hidden">
        <svg class="size-3.5 ${streaming ? "animate-pulse text-[var(--color-accent)]" : ""}"><use href="#i-brain"></use></svg>
        <span>${streaming ? "thinking…" : "thoughts"}</span>
        <svg class="ml-auto size-3.5 transition-transform group-open:rotate-180"><use href="#i-chevron"></use></svg>
      </summary>
      <div data-reasoning class="whitespace-pre-wrap break-words px-3 pb-3 text-[11px] italic leading-relaxed text-[var(--color-ink-faint)]">${esc(reasoning)}</div>
    </details>`;
}

export function placeholderHTML(icon: string, msg: string) {
  return `
    <div class="grid h-full place-items-center p-5 text-center text-[var(--color-ink-faint)]">
      <div class="flex flex-col items-center gap-2">
        ${svg(icon, "size-6 opacity-60")}
        <span class="text-[12px]">${esc(msg)}</span>
      </div>
    </div>`;
}

export function statPill(icon: string, value: string, label: string, best = false) {
  const iconColor: Record<string, string> = {
    "i-clock": "text-sky-400",
    "i-bolt": "text-amber-400",
    "i-clock-bolt": "text-violet-400",
    "i-down": "text-cyan-400",
    "i-up": "text-emerald-400",
    "i-gauge": "text-orange-400",
    "i-coin": "text-yellow-400",
  };
  const responsive = icon === "i-down" || icon === "i-clock-bolt" ? "hidden sm:flex" : "flex";
  return `
    <div tabindex="0" data-metric-tooltip="${esc(label)}" aria-label="${esc(`${label}: ${value}`)}" class="${responsive} items-center gap-1.5 rounded-md border ${best ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "border-[var(--color-line)] text-[var(--color-ink-dim)]"} px-2 py-1">
      ${svg(icon, `size-3.5 shrink-0 opacity-90 ${iconColor[icon] || "text-[var(--color-ink-dim)]"}`)}
      <span data-metric-value class="font-mono text-[11px] tabular-nums">${value}</span>
      ${best ? `<span class="text-[10px] font-medium uppercase tracking-wide">best</span>` : ""}
    </div>`;
}

let metricTooltipsInstalled = false;
export function installMetricTooltips() {
  if (metricTooltipsInstalled || typeof document === "undefined") return;
  metricTooltipsInstalled = true;
  const tooltip = document.createElement("div");
  tooltip.id = "metric-tooltip";
  tooltip.role = "tooltip";
  tooltip.hidden = true;
  tooltip.className =
    "pointer-events-none fixed z-[100] max-w-[20rem] rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-ink)] shadow-2xl";
  document.body.append(tooltip);

  let active: HTMLElement | null = null;
  const hide = () => {
    tooltip.hidden = true;
    active = null;
  };
  const show = (target: HTMLElement) => {
    const text = target.dataset.metricTooltip || target.dataset.tip;
    if (!text) return;
    active = target;
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    let top = rect.top - box.height - 9;
    if (top < 8) top = rect.bottom + 9;
    const left = Math.min(
      window.innerWidth - box.width - 8,
      Math.max(8, rect.left + rect.width / 2 - box.width / 2),
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  const targetOf = (event: Event) =>
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-metric-tooltip], [data-tip]")
      : null;

  document.addEventListener("pointerover", (event) => {
    const target = targetOf(event);
    if (target && target !== active) show(target);
  });
  document.addEventListener("pointerout", (event) => {
    const target = targetOf(event);
    if (!target || target !== active) return;
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
    hide();
  });
  document.addEventListener("focusin", (event) => {
    const target = targetOf(event);
    if (target) show(target);
  });
  document.addEventListener("focusout", (event) => {
    if (targetOf(event) === active) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
}

export function statsRowHTML(
  r: {
    durationMs: number;
    ttftMs?: number;
    genMs?: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
    costKnown?: boolean;
    usageEstimated?: boolean;
  },
  opts: { best?: Record<string, boolean>; live?: boolean } = {},
) {
  const best = opts.best || {};
  // Generation time = first received token to last received token. This
  // excludes both startup latency and any delay closing the API stream.
  const gen = r.genMs != null ? r.genMs : r.durationMs;
  const tput = gen > 0 ? r.completionTokens / (gen / 1000) : 0;
  const genLabel = opts.live
    ? "time generating (from first token)"
    : "generation time — first token to last token";
  const genValue = opts.live && gen <= 0 ? "—" : fmtDur(gen);
  const estimated = r.usageEstimated || opts.live;
  const suffix = estimated ? " est." : "";
  return `
    <div class="flex flex-wrap gap-1.5 px-3 py-3">
      ${statPill("i-clock", fmtDur(r.durationMs), "total time — request to finish", best.fast)}
      ${statPill("i-bolt", r.ttftMs != null && r.ttftMs > 0 ? fmtDur(r.ttftMs) : "—", "time to first token", best.ttft)}
      ${statPill("i-clock-bolt", genValue, genLabel, best.gen)}
      ${statPill("i-down", r.promptTokens ? `${fmtInt(r.promptTokens)}${suffix}` : "·", estimated ? "input tokens (estimate)" : "input tokens")}
      ${statPill("i-up", `${fmtInt(r.completionTokens)}${suffix}`, estimated ? "output tokens (estimate)" : "output tokens")}
      ${statPill("i-gauge", `${fmtRate(tput)} t/s`, "throughput — output tokens/sec from first token to last token", best.tput)}
      ${statPill("i-coin", `${fmtCost(r.cost, r.costKnown !== false)}${estimated && r.costKnown !== false ? " est." : ""}`, r.costKnown === false ? "price unknown" : estimated ? "cost (estimate)" : "cost", best.cheap)}
    </div>`;
}

// Re-balance highlight.js output line by line so we can prefix line numbers
// without breaking spans that span multiple lines.
function splitHighlightedLines(html: string): string[] {
  const open: string[] = [];
  return html.split("\n").map((raw) => {
    const prefix = open.join("");
    const re = /(<span\b[^>]*>)|(<\/span>)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      if (m[1]) open.push(m[1]);
      else open.pop();
    }
    return prefix + raw + "</span>".repeat(open.length);
  });
}
function numberedCodeHTML(highlighted: string): string {
  return `<div class="code-block">${splitHighlightedLines(highlighted)
    .map(
      (l, i) =>
        `<div class="code-line"><span class="code-ln">${i + 1}</span><span class="code-src language-html">${l || " "}</span></div>`,
    )
    .join("")}</div>`;
}

/* ------------------------ untrusted preview hardening --------------------- */
// API keys live in the parent page's localStorage (ab:key:*). The hard
// requirement is that preview code must never read that storage. Opaque-origin
// iframes (sandbox without allow-same-origin) enforce this: parent/top storage
// is cross-origin and inaccessible. Everything else (CSP, nav guard, allow=)
// is defense in depth around that boundary.
//
// Interactive demos still need JS. We keep them useful (inline scripts/styles,
// data: assets) while blocking network I/O, form exfil, nested frames, and
// escaping the preview chrome.
export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ");

/**
 * Tightest sandbox that still allows interactive demos.
 * MUST stay exactly "allow-scripts" — never add allow-same-origin (that would
 * let the preview share the parent origin and read localStorage / API keys).
 */
export const PREVIEW_SANDBOX = "allow-scripts";

/** CSP for the blob "open in new tab" wrapper. No scripts in the wrapper
 *  itself (blob pages inherit the app origin and could otherwise touch
 *  localStorage). frame-src stays open so the nested srcdoc iframe can load;
 *  that iframe is what carries PREVIEW_SANDBOX / PREVIEW_CSP. */
export const PREVIEW_WRAPPER_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "child-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
].join("; ");

const PREVIEW_FALLBACK_BACKGROUND = "#080a08";

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

// Tiny bridge injected into a preview so scroll-link can drive it via postMessage
// (the iframe is sandboxed without same-origin, so we can't touch it directly).
function scrollBridge(id: string): string {
  return `<script>(function(){var ID=${JSON.stringify(id)},lock=false;function engage(){lock=false;parent.postMessage({__ab:"engage",id:ID},"*")}["wheel","touchstart","pointerdown","keydown"].forEach(function(type){addEventListener(type,engage,{passive:true})});addEventListener("scroll",function(){if(lock)return;var h=document.documentElement.scrollHeight-innerHeight;parent.postMessage({__ab:"scroll",id:ID,ratio:h>0?scrollY/h:0},"*")},{passive:true});addEventListener("message",function(e){var d=e.data;if(d&&d.__ab==="set"&&d.id!==ID){lock=true;var root=document.documentElement,behavior=root.style.scrollBehavior,h=root.scrollHeight-innerHeight;root.style.scrollBehavior="auto";scrollTo(0,(d.ratio||0)*h);requestAnimationFrame(function(){root.style.scrollBehavior=behavior});setTimeout(function(){lock=false},120)}})})()</scr`+`ipt>`;
}

// Stops ordinary links and submissions from replacing the preview with a
// phishing page. The sandbox remains the primary boundary for scripted escape.
const PREVIEW_NAVIGATION_GUARD = `<script>(function(){var XLINK="http://www.w3.org/1999/xlink";function blockedLink(target){var link=target&&target.closest&&target.closest("a,area");if(!link)return false;link.removeAttribute("ping");var href=(link.getAttribute("href")||link.getAttributeNS(XLINK,"href")||"").trim();if(href!==""&&href.charAt(0)!=="#")return true;return false}addEventListener("click",function(event){if(blockedLink(event.target))event.preventDefault()},true);addEventListener("auxclick",function(event){if(blockedLink(event.target))event.preventDefault()},true);addEventListener("submit",function(event){event.preventDefault()},true)})()</scr`+`ipt>`;

/** Strip navigation gadgets that can leave the srcdoc document before CSP helps. */
function stripPreviewNavigationGadgets(code: string): string {
  return code
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<area\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)refresh\1[^>]*>/gi, "")
    .replace(
      /<link\b(?=[^>]*\brel\s*=\s*(?:"[^"]*\b(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)\b[^"]*"|'[^']*\b(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)\b[^']*'|[^\s>]*(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)[^\s>]*))[^>]*>/gi,
      "",
    );
}

/**
 * Prepare untrusted HTML for preview: strip navigation gadgets, force a strict
 * CSP, and optionally inject the scroll-sync bridge.
 */
export function hardenPreviewDocument(
  code: string,
  options: { bridgeId?: string } = {},
): string {
  const untrusted = stripPreviewNavigationGadgets(code);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const fallbackStyle = `<style>html,body{min-height:100%;background:${PREVIEW_FALLBACK_BACKGROUND}}</style>`;
  const securityBootstrap = `${cspMeta}${fallbackStyle}${PREVIEW_NAVIGATION_GUARD}`;
  const withoutDoctype = untrusted.replace(/<!doctype\b[^>]*>/gi, "");
  const htmlAttrs = withoutDoctype.match(/<html\b([^>]*)>/i)?.[1] || "";
  const completeDocument = withoutDoctype.match(
    /<head\b[^>]*>([\s\S]*?)<\/head>[\s\S]*?<body\b([^>]*)>([\s\S]*?)<\/body>/i,
  );
  // Rebuild complete documents so no attacker-controlled bytes can execute
  // before the CSP meta. Fragments are nested inside a fresh, protected body.
  let doc = completeDocument
    ? `<!DOCTYPE html><html${htmlAttrs}><head>${securityBootstrap}${completeDocument[1]}</head><body${completeDocument[2]}>${completeDocument[3]}</body></html>`
    : `<!DOCTYPE html><html${htmlAttrs}><head>${securityBootstrap}</head><body>${withoutDoctype}</body></html>`;

  if (options.bridgeId) {
    const bridge = scrollBridge(options.bridgeId);
    doc = doc.includes("</body>")
      ? doc.replace("</body>", `${bridge}</body>`)
      : `${doc}${bridge}`;
  }
  return doc;
}

/**
 * Blob-tab shell around untrusted HTML. The wrapper is same-origin with the
 * app (blob: inherits creator origin), so it must not run any script — only a
 * nested opaque-origin iframe may execute the demo.
 */
export function hardenedPreviewWrapperHTML(
  code: string,
  title = "AI Battle preview",
): string {
  const inner = hardenPreviewDocument(code);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_WRAPPER_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>html,body{margin:0;height:100%;background:${PREVIEW_FALLBACK_BACKGROUND}}iframe{display:block;width:100%;height:100%;border:0;background:${PREVIEW_FALLBACK_BACKGROUND}}</style></head><body><iframe sandbox="${PREVIEW_SANDBOX}" csp="${esc(PREVIEW_CSP)}" allow="${PREVIEW_ALLOW}" referrerpolicy="no-referrer" srcdoc="${esc(inner)}" title="${esc(title)}"></iframe></body></html>`;
}

/**
 * Open untrusted HTML in a new tab without giving it a free top-level page.
 * The blob wrapper is ours (no scripts); the demo runs inside a nested
 * sandboxed iframe without same-origin access to localStorage.
 */
export function openHardenedPreview(code: string, title = "AI Battle preview"): void {
  const wrapper = hardenedPreviewWrapperHTML(code, title);
  const url = URL.createObjectURL(new Blob([wrapper], { type: "text/html" }));
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function previewIframeHTML(r: ResultView, resultKey: string): string {
  const doc = hardenPreviewDocument(r.code, { bridgeId: resultKey });
  return `
    <div class="relative h-full bg-[var(--color-surface)] p-1.5">
      <button data-action="reload-preview" data-model="${esc(resultKey)}" aria-label="Restart preview" class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)]/90 px-2 py-1 text-[10px] text-[var(--color-ink-dim)] backdrop-blur transition-colors hover:text-[var(--color-ink)]" title="restart the demo">
        ${svg("i-refresh", "size-3.5")}<span>restart</span>
      </button>
      <iframe data-preview="${esc(resultKey)}" class="h-full w-full rounded-lg bg-[var(--color-surface)] opacity-0 shadow-inner transition-opacity duration-300 ease-out motion-reduce:transition-none" sandbox="${PREVIEW_SANDBOX}" csp="${esc(PREVIEW_CSP)}" allow="${PREVIEW_ALLOW}" referrerpolicy="no-referrer" srcdoc="${esc(doc)}" title="Preview generated by ${esc(r.id)}"></iframe>
    </div>`;
}

/** Fade previews in only after their srcdoc has finished loading. */
export function installPreviewFade(root: Document = document): void {
  root.addEventListener(
    "load",
    (event) => {
      const frame = event.target;
      if (!(frame instanceof HTMLIFrameElement) || !frame.matches("iframe[data-preview]"))
        return;
      requestAnimationFrame(() => {
        frame.classList.remove("opacity-0");
        frame.classList.add("opacity-100");
      });
    },
    true,
  );
}

export function restartPreview(frame: HTMLIFrameElement): void {
  frame.classList.remove("opacity-100");
  frame.classList.add("opacity-0");
  frame.srcdoc = frame.srcdoc;
}

// Content for a finished result (output / code / preview).
export function doneContentHTML(
  r: ResultView,
  viewMode: ViewMode,
  options: { deferPreview?: boolean } = {},
): string {
  const resultKey = r.key || r.id;
  if (viewMode === "preview") {
    if (!r.code) return placeholderHTML("i-browser", "no renderable HTML in this answer");
    if (options.deferPreview) {
      return `
        <div data-deferred-preview class="grid h-full place-items-center bg-[var(--color-panel)] p-6 text-center">
          <div class="flex max-w-sm flex-col items-center gap-3">
            ${svg("i-alert", "size-7 text-[var(--color-ink-faint)]")}
            <div>
              <p class="text-[13px] font-medium text-[var(--color-ink)]">This public preview contains untrusted code</p>
              <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">It runs offline in a restricted sandbox only after you approve it.</p>
            </div>
            <button data-action="run-preview" data-model="${esc(resultKey)}" class="mt-1 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-[12px] font-medium text-black transition-opacity hover:opacity-90">Run preview</button>
          </div>
        </div>`;
    }
    return previewIframeHTML(r, resultKey);
  }
  if (viewMode === "code") {
    if (!r.code) return placeholderHTML("i-code", "no code block found");
    return `
      <div class="relative h-full">
        <button data-action="copy" data-model="${esc(resultKey)}" aria-label="Copy generated code" aria-live="polite" class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)]/90 px-2 py-1 text-[10px] text-[var(--color-ink-dim)] backdrop-blur transition-colors hover:text-[var(--color-ink)]">
          ${svg("i-copy", "size-3.5")}<span>copy</span>
        </button>
        <div class="result-scroll hljs h-full overflow-auto py-2 text-[11px] leading-[1.6]">${numberedCodeHTML(r.codeHtml)}</div>
      </div>`;
  }
  const text = extractAnswer(r.raw);
  const thoughts = thoughtsHTML(r.reasoning || "", false);
  const codeCta = r.code
    ? `<div class="${text || thoughts ? "mt-5 border-t border-[var(--color-line)] pt-4" : ""}">
        <button type="button" data-action="view-code" data-model="${esc(resultKey)}" class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel)] px-3 py-2 text-[12px] text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)]">
          ${svg("i-code", "size-3.5")}<span>View code</span>
        </button>
      </div>`
    : "";
  if (!text && !thoughts) {
    if (!r.code) return placeholderHTML("i-text", "empty response");
    return `
      <div class="grid h-full place-items-center p-6 text-center">
        <div class="flex max-w-sm flex-col items-center gap-3">
          ${svg("i-code", "size-7 text-[var(--color-ink-faint)]")}
          <p class="text-[13px] text-[var(--color-ink-dim)]">This response is mostly code — open the Code tab to inspect it.</p>
          ${codeCta}
        </div>
      </div>`;
  }
  return `<div class="result-scroll h-full overflow-auto p-4 text-[13px] leading-relaxed text-[var(--color-ink-dim)]">${thoughts}<div class="whitespace-pre-wrap break-words">${esc(text)}</div>${codeCta}</div>`;
}

/* ------------------------------ scroll-link ------------------------------ */
export const SCROLLLINK_KEY = "ab:scrolllink";

// Sync vertical scroll across every result pane (text/code panes + preview
// iframes via postMessage) while `isOn()` returns true.
export function installScrollSync(isOn: () => boolean) {
  type ScrollSource = HTMLElement | string;
  let activeSource: ScrollSource | null = null;
  let activeUntil = 0;
  const suppressedUntil = new WeakMap<HTMLElement, number>();

  const claimSource = (source: ScrollSource) => {
    activeSource = source;
    activeUntil = performance.now() + 250;
    if (source instanceof HTMLElement) suppressedUntil.delete(source);
  };
  const anotherSourceIsActive = (source: ScrollSource) => {
    if (performance.now() > activeUntil) {
      activeSource = null;
      return false;
    }
    return activeSource !== null && activeSource !== source;
  };
  const applyToOthers = (ratio: number, source?: ScrollSource) => {
    const now = performance.now();
    $$<HTMLElement>(".result-scroll").forEach((el) => {
      if (el === source) return;
      const h = el.scrollHeight - el.clientHeight;
      suppressedUntil.set(el, now + 180);
      el.scrollTop = ratio * h;
    });
    $$<HTMLIFrameElement>("iframe[data-preview]").forEach((f) => {
      f.contentWindow?.postMessage(
        { __ab: "set", id: typeof source === "string" ? source : "__parent", ratio },
        "*",
      );
    });
  };

  const claimFromEvent = (event: Event) => {
    if (!isOn() || !(event.target instanceof Element)) return;
    const pane = event.target.closest<HTMLElement>(".result-scroll");
    if (pane) claimSource(pane);
  };
  for (const eventName of ["wheel", "touchstart", "pointerdown", "keydown"])
    document.addEventListener(eventName, claimFromEvent, { capture: true, passive: true });

  document.addEventListener(
    "scroll",
    (e) => {
      if (!isOn()) return;
      const src = e.target as HTMLElement;
      if (!(src instanceof HTMLElement) || !src.classList.contains("result-scroll")) return;
      if (anotherSourceIsActive(src)) return;
      if (performance.now() < (suppressedUntil.get(src) || 0)) return;
      claimSource(src);
      const h = src.scrollHeight - src.clientHeight;
      applyToOthers(h > 0 ? src.scrollTop / h : 0, src);
    },
    true,
  );
  window.addEventListener("message", (e) => {
    if (!isOn()) return;
    const d: any = e.data;
    if (
      !d ||
      (d.__ab !== "engage" && d.__ab !== "scroll") ||
      typeof d.id !== "string" ||
      (d.__ab === "scroll" && typeof d.ratio !== "number")
    )
      return;
    const frame = $$<HTMLIFrameElement>("iframe[data-preview]").find(
      (candidate) => candidate.contentWindow === e.source && candidate.dataset.preview === d.id,
    );
    if (!frame) return;
    if (d.__ab === "engage") {
      claimSource(d.id);
      return;
    }
    if (anotherSourceIsActive(d.id)) return;
    claimSource(d.id);
    applyToOthers(Number.isFinite(d.ratio) ? Math.min(1, Math.max(0, d.ratio)) : 0, d.id);
  });
}

/* ------------------------------- providers ------------------------------- */
export function providerBadge(p?: string) {
  const meta = p && p in PROVIDERS ? PROVIDERS[p as keyof typeof PROVIDERS] : undefined;
  if (!meta) return "";
  const mono = meta.logoMonochrome ? " brightness-0 invert" : "";
  return `<span class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide" style="color:${meta.color};background:${meta.color}1a" title="${esc(meta.name)}"><img src="${esc(meta.logo)}" alt="" class="size-3.5 object-contain${mono}">${esc(meta.short)}</span>`;
}

const INFERENCE_PROVIDERS = new Set(["openrouter", "groq", "cerebras", "local"]);

function iconTile(name: string, logo: string, monochrome = false) {
  const mono = monochrome ? " brightness-0 invert" : "";
  return `<span class="grid size-6 shrink-0 place-items-center overflow-hidden rounded-lg border border-[var(--color-line)] bg-black/20" title="${esc(name)}"><img src="${esc(logo)}" alt="" class="size-4 object-contain${mono}"></span>`;
}

export function modelBadge(provider?: string, modelId?: string) {
  const providerMeta =
    provider && provider in PROVIDERS ? PROVIDERS[provider as keyof typeof PROVIDERS] : undefined;
  const brand = modelId ? modelBrandFor(modelId) : null;
  if (!providerMeta || !INFERENCE_PROVIDERS.has(provider || "")) return providerBadge(provider);

  const inferenceIcon = iconTile(
    providerMeta.name,
    providerMeta.logo,
    providerMeta.logoMonochrome,
  );
  if (!brand) return inferenceIcon;
  return `<span class="inline-flex shrink-0 items-center gap-1">${inferenceIcon}${iconTile(brand.name, brand.logo, brand.monochrome)}</span>`;
}

export interface SummaryResult {
  key: string;
  id: string;
  provider?: string;
  label: string;
  state: "loading" | "streaming" | "done" | "error";
  durationMs: number;
  ttftMs?: number;
  genMs?: number;
  completionTokens: number;
  cost: number;
  costKnown?: boolean;
  usageEstimated?: boolean;
  cached?: boolean;
  concealed?: boolean;
  metrics?: MetricSample[];
}

const TIMELINE_COLORS = [
  "#d8ff3e",
  "#38bdf8",
  "#c084fc",
  "#fb7185",
  "#34d399",
  "#fb923c",
  "#facc15",
  "#a78bfa",
];

function timelineColor(_result: SummaryResult, index: number) {
  return TIMELINE_COLORS[index % TIMELINE_COLORS.length];
}

const TIMELINE_WIDTH = 760;
const TIMELINE_HEIGHT = 246;
const TIMELINE_LEFT = 58;
const TIMELINE_RIGHT = 64;
const TIMELINE_TOP = 25;
const TIMELINE_BOTTOM = 38;
const TIMELINE_PLOT_WIDTH = TIMELINE_WIDTH - TIMELINE_LEFT - TIMELINE_RIGHT;
const TIMELINE_PLOT_HEIGHT = TIMELINE_HEIGHT - TIMELINE_TOP - TIMELINE_BOTTOM;

type TimelineSeries = {
  key: string;
  label: string;
  color: string;
  index: number;
  samples: MetricSample[];
};

type TimelineModel = {
  series: TimelineSeries[];
  keys: string;
  maxTime: number;
  maxTokens: number;
  maxCost: number;
  hasKnownCosts: boolean;
  trackingSeries: { label: string; color: string; samples: MetricSample[] }[];
};

function buildTimelineModel(results: SummaryResult[]): TimelineModel | null {
  const sampledResults = results.filter(
    (result) => result.state !== "error" && (result.metrics?.length || 0) > 0,
  );
  const firstResponse = Math.min(
    ...sampledResults.flatMap((result) =>
      (result.metrics || [])
        .filter((sample) => sample.completionTokens > 0)
        .map((sample) => sample.tMs),
    ),
  );
  if (!Number.isFinite(firstResponse)) return null;

  const series = results
    .map((result, index) => {
      const samples = (result.metrics || [])
        .filter((sample) => sample.tMs >= firstResponse && sample.completionTokens > 0)
        .map((sample) => ({ ...sample, tMs: sample.tMs - firstResponse }));
      return {
        key: result.key,
        label: result.label,
        color: timelineColor(result, index),
        index,
        samples,
        state: result.state,
      };
    })
    .filter((item) => item.state !== "error" && item.samples.length > 0)
    .map(({ state: _state, ...item }) => item);

  if (!series.length) return null;

  const allSamples = series.flatMap(({ samples }) => samples);
  const knownCosts = allSamples.filter((sample) => sample.costKnown);
  return {
    series,
    keys: series.map((item) => item.key).join("|"),
    maxTime: Math.max(1, ...allSamples.map((sample) => sample.tMs)),
    maxTokens: Math.max(1, ...allSamples.map((sample) => sample.completionTokens)) * 1.08,
    maxCost: Math.max(1e-9, ...knownCosts.map((sample) => sample.cost)) * 1.08,
    hasKnownCosts: knownCosts.length > 0,
    trackingSeries: series.map(({ label, color, samples }) => ({ label, color, samples })),
  };
}

function timelineEmptyHTML(results: SummaryResult[]): string {
  const hasMetrics = results.some(
    (result) => result.state !== "error" && (result.metrics?.length || 0) > 0,
  );
  return `
    <div data-timeline-empty class="grid min-h-44 place-items-center px-6 py-8 text-center">
      <div class="max-w-sm text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        ${svg("i-gauge", "mx-auto mb-3 size-6 opacity-60")}
        <p>${hasMetrics ? "Waiting for the first model response…" : "Timeline data is unavailable for battles created before this feature."}</p>
      </div>
    </div>`;
}

function timelineDefsHTML(model: TimelineModel): string {
  return model.series
    .map(
      ({ color, index }) => `
        <linearGradient id="timeline-fill-${index}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity=".22"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>`,
    )
    .join("");
}

function timelineGridHTML(model: TimelineModel): string {
  const { maxTime, maxTokens, maxCost, hasKnownCosts } = model;
  const x = (tMs: number) => TIMELINE_LEFT + (tMs / maxTime) * TIMELINE_PLOT_WIDTH;
  const tokenY = (value: number) =>
    TIMELINE_TOP + TIMELINE_PLOT_HEIGHT - (value / maxTokens) * TIMELINE_PLOT_HEIGHT;
  const xTicks = Array.from({ length: 5 }, (_, index) => (maxTime * index) / 4);
  const tokenTicks = Array.from({ length: 5 }, (_, index) => (maxTokens * index) / 4);
  return [
    ...tokenTicks.map((value, index) => {
      const cy = tokenY(value);
      const costValue = (maxCost * index) / 4;
      return `
        <line x1="${TIMELINE_LEFT}" y1="${cy}" x2="${TIMELINE_WIDTH - TIMELINE_RIGHT}" y2="${cy}" stroke="rgba(255,255,255,.08)" stroke-dasharray="3 7"/>
        <text x="${TIMELINE_LEFT - 10}" y="${cy + 4}" text-anchor="end" fill="#858585" font-size="9">${fmtInt(Math.round(value))}</text>
        ${hasKnownCosts ? `<text x="${TIMELINE_WIDTH - TIMELINE_RIGHT + 10}" y="${cy + 4}" text-anchor="start" fill="#858585" font-size="9">${fmtCost(costValue)}</text>` : ""}`;
    }),
    ...xTicks.map((value) => {
      const cx = x(value);
      return `
        <line x1="${cx}" y1="${TIMELINE_TOP}" x2="${cx}" y2="${TIMELINE_TOP + TIMELINE_PLOT_HEIGHT}" stroke="rgba(255,255,255,.045)"/>
        <text x="${cx}" y="${TIMELINE_HEIGHT - 14}" text-anchor="middle" fill="#858585" font-size="9">${esc(fmtDur(value))}</text>`;
    }),
  ].join("");
}

function timelinePlotHTML(model: TimelineModel): string {
  const { maxTime, maxTokens, maxCost } = model;
  const x = (tMs: number) => TIMELINE_LEFT + (tMs / maxTime) * TIMELINE_PLOT_WIDTH;
  const tokenY = (value: number) =>
    TIMELINE_TOP + TIMELINE_PLOT_HEIGHT - (value / maxTokens) * TIMELINE_PLOT_HEIGHT;
  const costY = (value: number) =>
    TIMELINE_TOP + TIMELINE_PLOT_HEIGHT - (value / maxCost) * TIMELINE_PLOT_HEIGHT;
  return model.series
    .map(({ samples, color, index }) => {
      const tokenPoints = samples.map((sample) => ({
        cx: x(sample.tMs),
        cy: tokenY(sample.completionTokens),
      }));
      const tokenLine = tokenPoints
        .map(({ cx, cy }, pointIndex) => `${pointIndex ? "L" : "M"}${cx.toFixed(1)},${cy.toFixed(1)}`)
        .join(" ");
      const first = tokenPoints[0];
      const last = tokenPoints[tokenPoints.length - 1];
      const area = `${tokenLine} L${last.cx.toFixed(1)},${(TIMELINE_TOP + TIMELINE_PLOT_HEIGHT).toFixed(1)} L${first.cx.toFixed(1)},${(TIMELINE_TOP + TIMELINE_PLOT_HEIGHT).toFixed(1)} Z`;
      const costPoints = samples
        .filter((sample) => sample.costKnown)
        .map((sample) => ({ cx: x(sample.tMs), cy: costY(sample.cost) }));
      const costLine = costPoints
        .map(({ cx, cy }, pointIndex) => `${pointIndex ? "L" : "M"}${cx.toFixed(1)},${cy.toFixed(1)}`)
        .join(" ");
      const lastCost = costPoints.at(-1);
      return `
        <path d="${area}" fill="url(#timeline-fill-${index})"/>
        <path d="${tokenLine}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${costLine ? `<path d="${costLine}" fill="none" stroke="${color}" stroke-width="1.8" stroke-dasharray="7 6" stroke-linecap="round" stroke-linejoin="round" opacity=".9" vector-effect="non-scaling-stroke"/>` : ""}
        <circle cx="${last.cx.toFixed(1)}" cy="${last.cy.toFixed(1)}" r="4" fill="${color}" stroke="#0f0f0f" stroke-width="2" vector-effect="non-scaling-stroke"/>
        ${lastCost ? `<circle cx="${lastCost.cx.toFixed(1)}" cy="${lastCost.cy.toFixed(1)}" r="3.5" fill="#0f0f0f" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ""}`;
    })
    .join("");
}

function timelineLegendHTML(model: TimelineModel): string {
  return model.series
    .map(
      ({ label, color }) => `
        <li class="flex min-w-0 items-center gap-1.5">
          <span class="size-2 shrink-0 rounded-full" style="background:${color};box-shadow:0 0 10px ${color}80"></span>
          <span class="max-w-52 truncate text-[10px] text-[var(--color-ink-dim)]">${esc(label)}</span>
        </li>`,
    )
    .join("");
}

function applyTimelineFigureData(figure: HTMLElement, model: TimelineModel) {
  figure.dataset.seriesKeys = model.keys;
  figure.dataset.series = JSON.stringify(model.trackingSeries);
  figure.dataset.maxTime = String(model.maxTime);
  figure.dataset.maxTokens = String(model.maxTokens);
  figure.dataset.maxCost = String(model.maxCost);
  figure.dataset.chartLeft = String(TIMELINE_LEFT);
  figure.dataset.chartRight = String(TIMELINE_RIGHT);
  figure.dataset.chartTop = String(TIMELINE_TOP);
  figure.dataset.chartBottom = String(TIMELINE_BOTTOM);
}

function timelineChartHTML(model: TimelineModel): string {
  return `
    <figure data-timeline-chart class="relative" aria-label="Tokens and cost timeline by model">
      <div class="scroll-affordance overflow-x-auto">
        <svg viewBox="0 0 ${TIMELINE_WIDTH} ${TIMELINE_HEIGHT}" class="min-w-[36rem] w-full" role="img" aria-labelledby="timeline-title timeline-desc">
          <title id="timeline-title">Tokens and cost generated over time</title>
          <desc id="timeline-desc">Solid lines show output tokens and dashed lines show cost. The timeline begins when the first model responds.</desc>
          <defs data-timeline-defs>${timelineDefsHTML(model)}</defs>
          <g data-timeline-grid>${timelineGridHTML(model)}</g>
          <g data-timeline-plot>${timelinePlotHTML(model)}</g>
          <text x="${TIMELINE_LEFT}" y="14" fill="#a1a1a1" font-size="9" letter-spacing="1.2">TOKENS</text>
          <text data-timeline-cost-label x="${TIMELINE_WIDTH - TIMELINE_RIGHT}" y="14" text-anchor="end" fill="#a1a1a1" font-size="9" letter-spacing="1.2" ${model.hasKnownCosts ? "" : 'visibility="hidden"'}>COST (USD)</text>
          <g data-timeline-crosshair visibility="hidden">
            <line data-timeline-crosshair-line x1="${TIMELINE_LEFT}" y1="${TIMELINE_TOP}" x2="${TIMELINE_LEFT}" y2="${TIMELINE_TOP + TIMELINE_PLOT_HEIGHT}" stroke="rgba(255,255,255,.55)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>
            <g data-timeline-markers></g>
          </g>
          <rect data-timeline-hitbox x="${TIMELINE_LEFT}" y="${TIMELINE_TOP}" width="${TIMELINE_PLOT_WIDTH}" height="${TIMELINE_PLOT_HEIGHT}" fill="transparent" style="pointer-events:all;cursor:crosshair"/>
        </svg>
      </div>
      <div data-timeline-tooltip role="tooltip" class="pointer-events-none absolute z-20 hidden min-w-52 max-w-64 rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)]/95 px-3 py-2.5 text-[10px] shadow-2xl backdrop-blur"></div>
      <figcaption class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] px-4 py-2.5">
        <ul data-timeline-legend class="flex flex-wrap gap-x-4 gap-y-1.5" role="list">${timelineLegendHTML(model)}</ul>
        <span class="flex shrink-0 items-center gap-3 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          <span class="flex items-center gap-1.5"><i class="block w-5 border-t-2 border-current"></i>tokens</span>
          <span class="flex items-center gap-1.5"><i class="block w-5 border-t-2 border-dashed border-current"></i>cost</span>
        </span>
      </figcaption>
    </figure>`;
}

export function renderMetricsTimeline(results: SummaryResult[]): string {
  const model = buildTimelineModel(results);
  if (!model) return timelineEmptyHTML(results);
  const html = timelineChartHTML(model);
  // Attach dataset values after parse isn't available for string render — embed via replace.
  return html.replace(
    "<figure data-timeline-chart",
    `<figure data-timeline-chart data-series-keys="${esc(model.keys)}" data-series="${esc(JSON.stringify(model.trackingSeries))}" data-max-time="${model.maxTime}" data-max-tokens="${model.maxTokens}" data-max-cost="${model.maxCost}" data-chart-left="${TIMELINE_LEFT}" data-chart-right="${TIMELINE_RIGHT}" data-chart-top="${TIMELINE_TOP}" data-chart-bottom="${TIMELINE_BOTTOM}"`,
  );
}

/** Patch the live chart in place so hover tooltip/crosshair survive streaming updates. */
export function mountMetricsTimeline(root: HTMLElement, results: SummaryResult[]): void {
  const model = buildTimelineModel(results);
  const figure = root.querySelector<HTMLElement>("[data-timeline-chart]");

  if (!model) {
    if (!root.querySelector("[data-timeline-empty]")) root.innerHTML = timelineEmptyHTML(results);
    return;
  }

  if (!figure || figure.dataset.seriesKeys !== model.keys) {
    root.innerHTML = timelineChartHTML(model);
    const next = root.querySelector<HTMLElement>("[data-timeline-chart]");
    if (next) applyTimelineFigureData(next, model);
    return;
  }

  applyTimelineFigureData(figure, model);
  const defs = figure.querySelector("[data-timeline-defs]");
  const grid = figure.querySelector("[data-timeline-grid]");
  const plot = figure.querySelector("[data-timeline-plot]");
  const legend = figure.querySelector("[data-timeline-legend]");
  const costLabel = figure.querySelector<SVGTextElement>("[data-timeline-cost-label]");
  if (defs) defs.innerHTML = timelineDefsHTML(model);
  if (grid) grid.innerHTML = timelineGridHTML(model);
  if (plot) plot.innerHTML = timelinePlotHTML(model);
  if (legend) legend.innerHTML = timelineLegendHTML(model);
  if (costLabel) costLabel.setAttribute("visibility", model.hasKnownCosts ? "visible" : "hidden");

  // Refresh an open tooltip with the new samples at the same x-ratio.
  if (timelineHover && timelineHover.figure === figure) {
    paintTimelineAtRatio(
      figure,
      timelineHover.ratio,
      timelineHover.offsetX,
      timelineHover.offsetY,
    );
  }
}

let timelineTrackingInstalled = false;
type TimelineTrackingSeries = { label: string; color: string; samples: MetricSample[] };
let timelineHover: {
  figure: HTMLElement;
  ratio: number;
  offsetX: number;
  offsetY: number;
} | null = null;

function hideTimelineHover(figure: HTMLElement) {
  figure.querySelector<HTMLElement>("[data-timeline-tooltip]")?.classList.add("hidden");
  figure
    .querySelector<SVGGElement>("[data-timeline-crosshair]")
    ?.setAttribute("visibility", "hidden");
}

function paintTimelineAtRatio(
  figure: HTMLElement,
  ratio: number,
  offsetX: number,
  offsetY: number,
): boolean {
  const maxTime = Number(figure.dataset.maxTime) || 1;
  const maxTokens = Number(figure.dataset.maxTokens) || 1;
  const maxCost = Number(figure.dataset.maxCost) || 1;
  const left = Number(figure.dataset.chartLeft);
  const right = Number(figure.dataset.chartRight);
  const top = Number(figure.dataset.chartTop);
  const bottom = Number(figure.dataset.chartBottom);
  const plotWidth = TIMELINE_WIDTH - left - right;
  const plotHeight = TIMELINE_HEIGHT - top - bottom;
  const chartX = left + ratio * plotWidth;
  const targetTime = ratio * maxTime;

  let series: TimelineTrackingSeries[];
  try {
    series = JSON.parse(figure.dataset.series || "[]") as TimelineTrackingSeries[];
  } catch {
    return false;
  }
  const current = series
    .map((item) => ({
      ...item,
      sample: [...item.samples].reverse().find((sample) => sample.tMs <= targetTime),
    }))
    .filter((item) => item.sample);
  if (!current.length) {
    hideTimelineHover(figure);
    return true;
  }

  const crosshair = figure.querySelector<SVGGElement>("[data-timeline-crosshair]");
  const line = figure.querySelector<SVGLineElement>("[data-timeline-crosshair-line]");
  const markers = figure.querySelector<SVGGElement>("[data-timeline-markers]");
  const tooltip = figure.querySelector<HTMLElement>("[data-timeline-tooltip]");
  if (!crosshair || !line || !markers || !tooltip) return false;

  line.setAttribute("x1", String(chartX));
  line.setAttribute("x2", String(chartX));
  markers.innerHTML = current
    .map(({ color, sample }) => {
      const tokenY = top + plotHeight - (sample!.completionTokens / maxTokens) * plotHeight;
      const costY = top + plotHeight - (sample!.cost / maxCost) * plotHeight;
      return `<circle cx="${chartX}" cy="${tokenY}" r="4" fill="${color}" stroke="#0f0f0f" stroke-width="2"/>${sample!.costKnown ? `<circle cx="${chartX}" cy="${costY}" r="3.5" fill="#0f0f0f" stroke="${color}" stroke-width="2"/>` : ""}`;
    })
    .join("");
  crosshair.setAttribute("visibility", "visible");
  tooltip.innerHTML = `
      <div class="mb-2 font-mono text-[10px] text-[var(--color-ink-faint)]">${fmtDur(targetTime)} after first response</div>
      <div class="space-y-1.5">${current
        .map(
          ({ label, color, sample }) => `
            <div>
              <div class="flex items-center gap-1.5 text-[var(--color-ink)]"><span class="size-1.5 rounded-full" style="background:${color}"></span><span class="max-w-44 truncate">${esc(label)}</span></div>
              <div class="ml-3 mt-0.5 font-mono text-[var(--color-ink-dim)]">${fmtInt(sample!.completionTokens)} tokens · ${sample!.costKnown ? fmtCost(sample!.cost) : "cost —"}${sample!.estimated ? " est." : ""}</div>
            </div>`,
        )
        .join("")}</div>`;
  tooltip.classList.remove("hidden");
  const figureRect = figure.getBoundingClientRect();
  const tooltipWidth = 256;
  tooltip.style.left = `${Math.min(figureRect.width - tooltipWidth - 8, Math.max(8, offsetX + 12))}px`;
  tooltip.style.top = `${Math.max(8, offsetY - 26)}px`;
  return true;
}

export function installTimelineTracking() {
  if (timelineTrackingInstalled || typeof document === "undefined") return;
  timelineTrackingInstalled = true;
  document.addEventListener("pointermove", (event) => {
    if (!(event.target instanceof Element)) return;
    const hitbox = event.target.closest<SVGRectElement>("[data-timeline-hitbox]");
    const figure = hitbox?.closest<HTMLElement>("[data-timeline-chart]");
    if (!hitbox || !figure) return;
    const rect = hitbox.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const figureRect = figure.getBoundingClientRect();
    const offsetX = event.clientX - figureRect.left;
    const offsetY = event.clientY - figureRect.top;
    timelineHover = { figure, ratio, offsetX, offsetY };
    paintTimelineAtRatio(figure, ratio, offsetX, offsetY);
  });
  document.addEventListener("pointerout", (event) => {
    if (!(event.target instanceof Element)) return;
    const hitbox = event.target.closest("[data-timeline-hitbox]");
    if (!(hitbox instanceof Element) || !hitbox.isConnected) return;
    const figure = hitbox.closest<HTMLElement>("[data-timeline-chart]");
    if (!figure) return;
    const related = event.relatedTarget;
    if (related instanceof Node && hitbox.contains(related)) return;
    if (timelineHover?.figure === figure) timelineHover = null;
    hideTimelineHover(figure);
  });
}

export function renderBattleInsights(results: SummaryResult[]): string {
  const active = results.filter((result) => result.state !== "error");
  if (!active.length) return "";
  const completed = active.filter((result) => result.state === "done");
  const totalTokens = active.reduce((sum, result) => sum + result.completionTokens, 0);
  const knownCosts = active.filter((result) => result.costKnown !== false);
  const totalCost = knownCosts.reduce((sum, result) => sum + result.cost, 0);
  const wallTime = Math.max(0, ...active.map((result) => result.durationMs));
  const fastest = completed.length
    ? completed.reduce((a, b) => (b.durationMs < a.durationMs ? b : a))
    : null;
  const throughput = (result: SummaryResult) =>
    result.completionTokens / ((result.genMs || result.durationMs || 1) / 1000);
  const fastestStream = completed.length
    ? completed.reduce((a, b) => (throughput(b) > throughput(a) ? b : a))
    : null;
  const insight = (icon: string, label: string, value: string, color: string) => `
    <div class="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
      <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">${svg(icon, `size-3.5 ${color}`)}${label}</div>
      <div class="mt-1.5 font-mono text-[15px] tabular-nums text-[var(--color-ink)]">${value}</div>
    </div>`;
  return `
    <div class="p-4">
      <div class="mb-3 font-pixel text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">Battle at a glance</div>
      <div class="grid grid-cols-2 gap-2">
        ${insight("i-clock", "wall time", fmtDur(wallTime), "text-sky-400")}
        ${insight("i-up", "output", fmtInt(totalTokens), "text-emerald-400")}
        ${insight("i-coin", "total cost", knownCosts.length ? fmtCost(totalCost) : "—", "text-yellow-400")}
        ${insight("i-hash", "models", String(active.length), "text-violet-400")}
      </div>
      <div class="mt-4 space-y-2 border-t border-[var(--color-line)] pt-3">
        ${fastest ? `<div class="flex items-center justify-between gap-3 text-[10px]"><span class="text-[var(--color-ink-faint)]">Fastest finish</span><span class="max-w-36 truncate text-right text-[var(--color-ink)]">${esc(fastest.label)}</span></div>` : ""}
        ${fastestStream ? `<div class="flex items-center justify-between gap-3 text-[10px]"><span class="text-[var(--color-ink-faint)]">Best throughput</span><span class="max-w-36 truncate text-right text-[var(--color-ink)]">${esc(fastestStream.label)}</span></div>` : ""}
      </div>
    </div>`;
}

export function comparisonWinners(results: SummaryResult[]) {
  const done = results.filter((result) => result.state === "done");
  if (done.length < 2) return new Map<string, string[]>();
  const rate = (result: SummaryResult) =>
    result.completionTokens / ((result.genMs || result.durationMs || 1) / 1000);
  const knownCosts = done.filter((result) => result.costKnown !== false);
  const winners = {
    fast: done.reduce((a, b) => (b.durationMs < a.durationMs ? b : a)),
    ttft: done.reduce((a, b) => ((b.ttftMs || Infinity) < (a.ttftMs || Infinity) ? b : a)),
    gen: done.reduce((a, b) => ((b.genMs || Infinity) < (a.genMs || Infinity) ? b : a)),
    tput: done.reduce((a, b) => (rate(b) > rate(a) ? b : a)),
    cheap: knownCosts.length
      ? knownCosts.reduce((a, b) => (b.cost < a.cost ? b : a))
      : null,
  };
  const labels = new Map<string, string[]>();
  const add = (result: SummaryResult | null, label: string) => {
    if (!result) return;
    labels.set(result.key, [...(labels.get(result.key) || []), label]);
  };
  add(winners.fast, "fastest");
  add(winners.ttft, "first token");
  add(winners.gen, "generation");
  add(winners.tput, "throughput");
  add(winners.cheap, "cheapest");
  return labels;
}

export function renderBattleSummary(results: SummaryResult[]): string {
  if (!results.length) return "";
  const winners = comparisonWinners(results);
  return `
    <table class="w-full min-w-[760px] border-collapse text-left text-[11px]">
      <thead class="text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
        <tr>
          <th class="px-4 py-2 font-normal">model</th>
          <th class="px-3 py-2 font-normal">total</th>
          <th class="px-3 py-2 font-normal">TTFT</th>
          <th class="px-3 py-2 font-normal">generation</th>
          <th class="px-3 py-2 font-normal">tokens/s</th>
          <th class="px-3 py-2 font-normal">output</th>
          <th class="px-3 py-2 font-normal">cost</th>
        </tr>
      </thead>
      <tbody>
        ${results
          .map((result) => {
            const ok = result.state === "done";
            const gen = result.genMs || result.durationMs;
            const rate = gen > 0 ? result.completionTokens / (gen / 1000) : 0;
            const badges = (winners.get(result.key) || [])
              .map(
                (label) =>
                  `<span class="rounded-md bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">${label}</span>`,
              )
              .join("");
            return `
              <tr class="border-t border-[var(--color-line)] ${ok ? "" : "text-red-400/80"}">
                <td class="px-4 py-2.5">
                  <div class="flex min-w-[15rem] items-center gap-2">
                    ${result.concealed ? "" : modelBadge(result.provider, result.id)}
                    <span class="max-w-[16rem] truncate text-[var(--color-ink)]"${result.concealed ? "" : ` title="${esc(result.key)}"`}>${esc(result.label)}</span>
                    ${result.cached ? `<span class="rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-ink-faint)]">cached</span>` : ""}
                    ${badges}
                  </div>
                </td>
                ${
                  ok
                    ? `<td class="px-3 py-2.5 font-mono tabular-nums">${fmtDur(result.durationMs)}</td>
                       <td class="px-3 py-2.5 font-mono tabular-nums">${result.ttftMs ? fmtDur(result.ttftMs) : "—"}</td>
                       <td class="px-3 py-2.5 font-mono tabular-nums">${fmtDur(gen)}</td>
                       <td class="px-3 py-2.5 font-mono tabular-nums">${fmtRate(rate)}</td>
                       <td class="px-3 py-2.5 font-mono tabular-nums">${fmtInt(result.completionTokens)}${result.usageEstimated ? " est." : ""}</td>
                       <td class="px-3 py-2.5 font-mono tabular-nums">${fmtCost(result.cost, result.costKnown !== false)}${result.usageEstimated && result.costKnown !== false ? " est." : ""}</td>`
                    : `<td class="px-3 py-2.5" colspan="6">${result.state}</td>`
                }
              </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

/* ------------------------------- history --------------------------------- */
export const HISTORY_KEY = "ab:history";
export const HISTORY_LIMIT = 25;

export interface HistoryResult {
  id: string;
  key?: string;
  provider?: string;
  label: string;
  raw: string;
  code: string;
  state: "done" | "error";
  error: string;
  warning?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  costKnown?: boolean;
  usageEstimated?: boolean;
  durationMs: number;
  ttftMs?: number;
  genMs?: number; // generation time (first token → last token); absent on old records
  reasoning?: string; // the model's chain-of-thought, if any
  metrics?: MetricSample[];
}
export interface BlindBattleState {
  enabled: boolean;
  revealed: boolean;
  order: string[];
  aliases: Record<string, string>;
}
export interface Battle {
  id: string;
  schemaVersion?: number;
  ts: number;
  prompt: string;
  system: string;
  results: HistoryResult[];
  blind?: BlindBattleState;
  sharedId?: string;
}

export function loadHistory(): Battle[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((battle: Battle) => ({
      ...battle,
      schemaVersion: 3,
      results: (battle.results || []).map((result) => ({
        ...result,
        key:
          result.key ||
          (result.provider ? `${result.provider}::${result.id}` : `openrouter::${result.id}`),
        ttftMs:
          result.ttftMs ??
          (result.genMs != null ? Math.max(0, result.durationMs - result.genMs) : undefined),
        costKnown:
          result.costKnown ?? (result.provider === "local" || result.cost > 0),
        usageEstimated: result.usageEstimated ?? false,
        metrics: Array.isArray(result.metrics)
          ? downsampleMetricSamples(
              result.metrics.filter(
                (sample) =>
                  Number.isFinite(sample.tMs) &&
                  Number.isFinite(sample.completionTokens) &&
                  Number.isFinite(sample.cost),
              ),
            )
          : [],
      })),
    }));
  } catch {
    return [];
  }
}
export function saveHistory(list: Battle[]): Battle[] {
  let out = list.slice(0, HISTORY_LIMIT).map((battle) => ({ ...battle, schemaVersion: 3 }));
  while (out.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
      return out;
    } catch {
      out = out.slice(0, -1); // drop oldest on quota error
    }
  }
  localStorage.removeItem(HISTORY_KEY);
  return out;
}
export function getBattle(id: string): Battle | null {
  return loadHistory().find((b) => b.id === id || String(b.ts) === id) || null;
}
export function fmtWhen(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
