/* =========================================================================
   /battle?id=… — read-only review of a saved battle from localStorage.
   ========================================================================= */
import {
  getBattle,
  doneContentHTML,
  statsRowHTML,
  esc,
  svg,
  fmtWhen,
  extractCode,
  formatCode,
  highlightCode,
  installScrollSync,
  providerBadge,
  SCROLLLINK_KEY,
  type ViewMode,
  type Battle,
  type HistoryResult,
} from "./lib";

const VIEW_KEY = "ab:view";
const $ = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector(s) as T;

const id = new URLSearchParams(location.search).get("id") || "";
const battle = getBattle(id);

if (!battle) {
  const nf = $("#battle-notfound");
  nf.classList.remove("hidden");
  nf.classList.add("grid");
} else {
  const view = $("#battle-view");
  view.classList.remove("hidden");
  view.classList.add("flex");
  initBattle(battle);
}

type V = HistoryResult & { codeFmt: string; codeHtml: string };

function initBattle(b: Battle) {
  $("#battle-when").textContent = fmtWhen(b.ts);
  const promptEl = $("#battle-prompt");
  if (b.prompt) promptEl.textContent = b.prompt;
  else promptEl.innerHTML = `<span class="text-[var(--color-ink-faint)]">(empty prompt)</span>`;

  // Re-derive the formatted + highlighted code for each saved result.
  const views: V[] = b.results.map((r) => {
    const code = r.code || (r.state === "done" ? extractCode(r.raw) : "");
    const codeFmt = code ? formatCode(code) : "";
    const codeHtml = codeFmt ? highlightCode(codeFmt) : "";
    return { ...r, code, codeFmt, codeHtml };
  });

  // Winner highlights (same logic as the arena).
  const done = views.filter((v) => v.state === "done");
  const best = new Map<string, Record<string, boolean>>();
  if (done.length >= 2) {
    const fast = done.reduce((a, c) => (c.durationMs < a.durationMs ? c : a));
    const cheap = done.reduce((a, c) => (c.cost < a.cost ? c : a));
    const rate = (r: V) => r.completionTokens / (r.genMs || r.durationMs || 1);
    const tput = done.reduce((a, c) => (rate(c) > rate(a) ? c : a));
    for (const v of done)
      best.set(v.id, {
        fast: v === fast,
        cheap: v === cheap && v.cost > 0,
        tput: v === tput,
      });
  }

  let viewMode = (localStorage.getItem(VIEW_KEY) as ViewMode) || "preview";
  let scrollLink = localStorage.getItem(SCROLLLINK_KEY) === "1";
  const results = $("#results");

  function cardHTML(v: V): string {
    const dot = v.state === "error" ? "bg-red-500" : "bg-emerald-400";
    const hasCode = v.state === "done" && !!v.code;
    const content =
      v.state === "error"
        ? `<div class="grid h-full place-items-center p-5 text-center"><div class="flex flex-col items-center gap-2 text-red-400/90">${svg("i-alert", "size-6")}<span class="max-w-[24rem] text-[12px] leading-relaxed">${esc(v.error || "Request failed.")}</span></div></div>`
        : doneContentHTML(v, viewMode);
    const stats =
      v.state === "error"
        ? ""
        : statsRowHTML(
            {
              durationMs: v.durationMs,
              genMs: v.genMs,
              promptTokens: v.promptTokens,
              completionTokens: v.completionTokens,
              cost: v.cost,
            },
            { best: best.get(v.id) || {} },
          );
    return `
      <article class="result-card flex flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div class="flex items-center gap-2 px-3 py-2.5">
          <span class="size-2 shrink-0 rounded-full ${dot}"></span>
          ${providerBadge(v.provider)}
          <span class="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink)]" title="${esc(v.id)}">${esc(v.label || v.id)}</span>
          ${hasCode ? `<button data-action="open" data-model="${esc(v.id)}" class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]" title="open preview in new tab">${svg("i-expand", "size-4")}</button>` : ""}
        </div>
        <div>${stats}</div>
        <div class="h-[clamp(22rem,52vh,42rem)] border-t border-[var(--color-line)] bg-[var(--color-surface)]">${content}</div>
      </article>`;
  }
  const renderAll = () => (results.innerHTML = views.map(cardHTML).join(""));
  renderAll();

  /* view tabs ----------------------------------------------------------- */
  const viewControls = $("#view-controls");
  function refreshTabs() {
    viewControls.querySelectorAll<HTMLElement>(".view-tab").forEach((tab) => {
      const on = tab.dataset.mode === viewMode;
      tab.classList.toggle("bg-[var(--color-panel-hi)]", on);
      tab.classList.toggle("text-[var(--color-ink)]", on);
      tab.classList.toggle("text-[var(--color-ink-dim)]", !on);
      tab.setAttribute("aria-selected", String(on));
    });
  }
  function setView(mode: ViewMode) {
    viewMode = mode;
    localStorage.setItem(VIEW_KEY, mode);
    refreshTabs();
    renderAll();
  }
  refreshTabs();
  viewControls.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest(".view-tab") as HTMLElement;
    if (t) setView(t.dataset.mode as ViewMode);
  });

  /* scroll link --------------------------------------------------------- */
  const scrollBtn = $("#scroll-link-btn");
  function refreshScrollBtn() {
    scrollBtn.classList.toggle("border-[var(--color-accent)]", scrollLink);
    scrollBtn.classList.toggle("text-[var(--color-accent)]", scrollLink);
    scrollBtn.classList.toggle("text-[var(--color-ink-dim)]", !scrollLink);
    scrollBtn.setAttribute("aria-pressed", String(scrollLink));
  }
  function toggleScrollLink() {
    scrollLink = !scrollLink;
    localStorage.setItem(SCROLLLINK_KEY, scrollLink ? "1" : "0");
    refreshScrollBtn();
  }
  refreshScrollBtn();
  scrollBtn.addEventListener("click", toggleScrollLink);
  installScrollSync(() => scrollLink);

  /* per-card actions ---------------------------------------------------- */
  results.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    const v = views.find((x) => x.id === btn.dataset.model);
    if (!v) return;
    if (btn.dataset.action === "copy" && v.code) {
      await navigator.clipboard.writeText(v.codeFmt || v.code);
      const sp = btn.querySelector("span");
      if (sp) {
        const prev = sp.textContent;
        sp.textContent = "copied";
        setTimeout(() => (sp.textContent = prev), 1200);
      }
    } else if (btn.dataset.action === "reload-preview") {
      const f = btn
        .closest("article")
        ?.querySelector("iframe[data-preview]") as HTMLIFrameElement | null;
      if (f) f.srcdoc = f.srcdoc;
    } else if (btn.dataset.action === "open" && v.code) {
      const blob = new Blob([v.code], { type: "text/html" });
      window.open(URL.createObjectURL(blob), "_blank");
    }
  });

  /* keyboard ------------------------------------------------------------ */
  const isTyping = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      location.href = "/";
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const map: Record<string, () => void> = {
      o: () => setView("output"),
      c: () => setView("code"),
      p: () => setView("preview"),
      l: () => toggleScrollLink(),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}
