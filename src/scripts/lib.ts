/* =========================================================================
   Shared helpers used by both the arena (index) and the battle detail route.
   Pure functions + result rendering + history storage. No page-specific state.
   ========================================================================= */
import hljs from "highlight.js/lib/core";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import beautify from "js-beautify";

hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("javascript", javascript);

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
export const fmtCost = (v: number) => {
  if (!v) return "$0";
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(2)}`;
};
export const fmtRate = (n: number) => (n >= 1 ? `${Math.round(n)}` : n.toFixed(1));
export const estTokens = (s: string) => (s ? Math.max(1, Math.round(s.length / 4)) : 0);

/* ----------------------------- code handling ----------------------------- */
export function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)].map((b) =>
    b[1].trim(),
  );
  let html = blocks.find((b) => /<!doctype html|<html[\s>]/i.test(b));
  if (!html && blocks.length) html = blocks[0];
  if (!html && /<!doctype html|<html[\s>]/i.test(text)) html = text.trim();
  return html || "";
}
export function formatCode(code: string): string {
  try {
    return beautify.html(code, {
      indent_size: 2,
      wrap_line_length: 0,
      preserve_newlines: true,
      max_preserve_newlines: 1,
      end_with_newline: false,
    });
  } catch {
    return code;
  }
}
export function highlightCode(code: string): string {
  try {
    return hljs.highlight(code, { language: "xml" }).value;
  } catch {
    return code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  }
}

/* --------------------------- result rendering ---------------------------- */
export interface ResultView {
  id: string;
  raw: string;
  reasoning?: string;
  code: string;
  codeFmt: string;
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
  return `
    <div class="flex items-center gap-1.5 rounded-md border ${best ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "border-[var(--color-line)] text-[var(--color-ink-dim)]"} px-2 py-1" title="${esc(label)}">
      ${svg(icon, "size-3.5 shrink-0 opacity-70")}
      <span class="font-mono text-[11px] tabular-nums">${value}</span>
    </div>`;
}

export function statsRowHTML(
  r: {
    durationMs: number;
    genMs?: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  },
  opts: { best?: Record<string, boolean>; live?: boolean } = {},
) {
  const best = opts.best || {};
  // Generation time = from the first token to the end (excludes the startup
  // latency before the first token). Throughput is measured over it.
  const gen = r.genMs != null ? r.genMs : r.durationMs;
  const tput = gen > 0 ? r.completionTokens / (gen / 1000) : 0;
  const genLabel = opts.live ? "time generating (from first token)" : "generation time — from the first token";
  const genValue = opts.live && gen <= 0 ? "—" : fmtDur(gen);
  return `
    <div class="flex flex-wrap gap-1.5 px-3 pb-3">
      ${statPill("i-clock", fmtDur(r.durationMs), "total time — request to finish", best.fast)}
      ${statPill("i-clock-bolt", genValue, genLabel, best.gen)}
      ${statPill("i-down", r.promptTokens ? fmtInt(r.promptTokens) : "·", "input tokens")}
      ${statPill("i-up", fmtInt(r.completionTokens), opts.live ? "output tokens (live estimate)" : "output tokens")}
      ${statPill("i-gauge", `${fmtRate(tput)} t/s`, "throughput — tokens/sec while generating", best.tput)}
      ${statPill("i-coin", fmtCost(r.cost), opts.live ? "cost (estimate)" : "cost", best.cheap)}
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

// Tiny bridge injected into a preview so scroll-link can drive it via postMessage
// (the iframe is sandboxed without same-origin, so we can't touch it directly).
function scrollBridge(id: string): string {
  return `<script>(function(){var ID=${JSON.stringify(id)},lock=false;addEventListener("scroll",function(){if(lock)return;var h=document.documentElement.scrollHeight-innerHeight;parent.postMessage({__ab:"scroll",id:ID,ratio:h>0?scrollY/h:0},"*")},{passive:true});addEventListener("message",function(e){var d=e.data;if(d&&d.__ab==="set"&&d.id!==ID){lock=true;var h=document.documentElement.scrollHeight-innerHeight;scrollTo(0,(d.ratio||0)*h);setTimeout(function(){lock=false},80)}})})()</scr`+`ipt>`;
}

// Content for a finished result (output / code / preview).
export function doneContentHTML(r: ResultView, viewMode: ViewMode): string {
  if (viewMode === "preview") {
    if (!r.code) return placeholderHTML("i-browser", "no renderable HTML in this answer");
    const bridge = scrollBridge(r.id);
    const doc = r.code.includes("</body>")
      ? r.code.replace("</body>", `${bridge}</body>`)
      : r.code + bridge;
    return `
      <div class="relative h-full">
        <button data-action="reload-preview" data-model="${esc(r.id)}" class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)]/90 px-2 py-1 text-[10px] text-[var(--color-ink-dim)] backdrop-blur transition-colors hover:text-[var(--color-ink)]" title="restart the demo">
          ${svg("i-refresh", "size-3.5")}<span>restart</span>
        </button>
        <iframe data-preview="${esc(r.id)}" class="h-full w-full bg-white" sandbox="allow-scripts allow-modals allow-popups allow-forms" srcdoc="${esc(doc)}" title="preview"></iframe>
      </div>`;
  }
  if (viewMode === "code") {
    if (!r.code) return placeholderHTML("i-code", "no code block found");
    return `
      <div class="relative h-full">
        <button data-action="copy" data-model="${esc(r.id)}" class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)]/90 px-2 py-1 text-[10px] text-[var(--color-ink-dim)] backdrop-blur transition-colors hover:text-[var(--color-ink)]">
          ${svg("i-copy", "size-3.5")}<span>copy</span>
        </button>
        <div class="result-scroll hljs h-full overflow-auto py-2 text-[11px] leading-[1.6]">${numberedCodeHTML(r.codeHtml)}</div>
      </div>`;
  }
  const text = r.raw.trim();
  const thoughts = thoughtsHTML(r.reasoning || "", false);
  if (!text && !thoughts) return placeholderHTML("i-text", "empty response");
  return `<div class="result-scroll h-full overflow-auto p-3.5 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">${thoughts}<div class="whitespace-pre-wrap break-words">${esc(text)}</div></div>`;
}

/* ------------------------------ scroll-link ------------------------------ */
export const SCROLLLINK_KEY = "ab:scrolllink";

// Sync vertical scroll across every result pane (text/code panes + preview
// iframes via postMessage) while `isOn()` returns true.
export function installScrollSync(isOn: () => boolean) {
  let syncing = false;
  const applyToOthers = (ratio: number, source?: Element) => {
    syncing = true;
    document.querySelectorAll<HTMLElement>(".result-scroll").forEach((el) => {
      if (el === source) return;
      const h = el.scrollHeight - el.clientHeight;
      el.scrollTop = ratio * h;
    });
    document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]").forEach((f) => {
      f.contentWindow?.postMessage({ __ab: "set", id: "__parent", ratio }, "*");
    });
    requestAnimationFrame(() => (syncing = false));
  };
  document.addEventListener(
    "scroll",
    (e) => {
      if (!isOn() || syncing) return;
      const src = e.target as HTMLElement;
      if (!(src instanceof HTMLElement) || !src.classList.contains("result-scroll")) return;
      const h = src.scrollHeight - src.clientHeight;
      applyToOthers(h > 0 ? src.scrollTop / h : 0, src);
    },
    true,
  );
  window.addEventListener("message", (e) => {
    if (!isOn() || syncing) return;
    const d: any = e.data;
    if (!d || d.__ab !== "scroll") return;
    syncing = true;
    document.querySelectorAll<HTMLElement>(".result-scroll").forEach((el) => {
      const h = el.scrollHeight - el.clientHeight;
      el.scrollTop = (d.ratio || 0) * h;
    });
    document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]").forEach((f) => {
      f.contentWindow?.postMessage({ __ab: "set", id: d.id, ratio: d.ratio || 0 }, "*");
    });
    requestAnimationFrame(() => (syncing = false));
  });
}

/* ------------------------------- providers ------------------------------- */
export const PROVIDER_META: Record<string, { name: string; short: string; color: string }> = {
  openrouter: { name: "OpenRouter", short: "OR", color: "#d8ff3e" },
  openai: { name: "OpenAI", short: "OpenAI", color: "#10a37f" },
  anthropic: { name: "Anthropic", short: "Claude", color: "#d97757" },
  local: { name: "Local", short: "Local", color: "#8b93a7" },
};
export function providerBadge(p?: string) {
  const meta = p ? PROVIDER_META[p] : undefined;
  if (!meta) return "";
  return `<span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide" style="color:${meta.color};background:${meta.color}1a" title="${meta.name}">${esc(meta.short)}</span>`;
}

/* ------------------------------- history --------------------------------- */
export const HISTORY_KEY = "ab:history";
export const HISTORY_LIMIT = 25;

export interface HistoryResult {
  id: string;
  provider?: string;
  label: string;
  raw: string;
  code: string;
  state: "done" | "error";
  error: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  genMs?: number; // generation time (first token → end); absent on old records
  reasoning?: string; // the model's chain-of-thought, if any
}
export interface Battle {
  id: string;
  ts: number;
  prompt: string;
  system: string;
  results: HistoryResult[];
}

export function loadHistory(): Battle[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}
export function saveHistory(list: Battle[]): Battle[] {
  let out = list.slice(0, HISTORY_LIMIT);
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
