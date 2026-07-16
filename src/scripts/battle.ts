/* =========================================================================
   /battle?id=… — read-only review of a saved battle from localStorage.
   ========================================================================= */
import {
  $,
  getBattle,
  loadHistory,
  saveHistory,
  doneContentHTML,
  openHardenedPreview,
  statsRowHTML,
  esc,
  svg,
  fmtWhen,
  extractCode,
  installScrollSync,
  modelBadge,
  renderBattleSummary,
  mountMetricsTimeline,
  renderBattleInsights,
  installMetricTooltips,
  installTimelineTracking,
  installPreviewFade,
  restartPreview,
  SCROLLLINK_KEY,
  type ViewMode,
  type Battle,
  type HistoryResult,
} from "./lib";
import { parseSharedBattle, sharedBattleToBattle } from "./shared-battle";
import { play } from "cuelume";

const VIEW_KEY = "ab:view";

installMetricTooltips();
installTimelineTracking();
installPreviewFade();

// Fetch the formatter/highlighter chunk in parallel with the battle itself.
const codeRender = import("./code-render");

const id = new URLSearchParams(location.search).get("id") || "";
const localBattle = getBattle(id);
const isPublicBattle = !localBattle;

async function loadBattle(): Promise<Battle | null> {
  if (localBattle) return localBattle;
  if (!id) return null;
  try {
    const response = await fetch(`/api/battles/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    return sharedBattleToBattle(parseSharedBattle(await response.json()));
  } catch {
    return null;
  }
}

const battle = await loadBattle();
if (!battle) {
  const nf = $("#battle-notfound");
  nf.classList.remove("hidden");
  nf.classList.add("grid");
} else {
  const view = $("#battle-view");
  view.classList.remove("hidden");
  view.classList.add("flex");
  await initBattle(battle);
}

type V = HistoryResult & { codeHtml: string };

async function initBattle(b: Battle) {
  const { highlightCode } = await codeRender;
  const activatedPreviews = new Set<string>();
  $("#battle-when").textContent = fmtWhen(b.ts);
  const promptEl = $("#battle-prompt");
  if (b.prompt) promptEl.textContent = b.prompt;
  else promptEl.innerHTML = `<span class="text-[var(--color-ink-faint)]">(empty prompt)</span>`;

  // Re-derive the formatted + highlighted code for each saved result.
  const views: V[] = b.results.map((r) => {
    const code = r.code || (r.state === "done" ? extractCode(r.raw) : "");
    const codeHtml = code ? highlightCode(code) : "";
    return { ...r, code, codeHtml };
  });
  const keyOf = (result: HistoryResult) =>
    result.key || `${result.provider || "openrouter"}::${result.id}`;
  if (b.blind?.order.length) {
    const positions = new Map(b.blind.order.map((key, index) => [key, index]));
    views.sort(
      (a, c) => (positions.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (positions.get(keyOf(c)) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  let revealed = !b.blind?.enabled || !!b.blind.revealed;
  const concealed = () => !!b.blind?.enabled && !revealed;
  const displayLabel = (result: HistoryResult) =>
    concealed() ? b.blind?.aliases[keyOf(result)] || "Model ?" : result.label || result.id;

  // Winner highlights (same logic as the arena).
  const done = views.filter((v) => v.state === "done");
  const best = new Map<string, Record<string, boolean>>();
  if (done.length >= 2) {
    const fast = done.reduce((a, c) => (c.durationMs < a.durationMs ? c : a));
    const knownCosts = done.filter((result) => result.costKnown !== false);
    const cheap = knownCosts.length
      ? knownCosts.reduce((a, c) => (c.cost < a.cost ? c : a))
      : null;
    const ttft = done.reduce((a, c) => ((c.ttftMs || Infinity) < (a.ttftMs || Infinity) ? c : a));
    const gen = done.reduce((a, c) => ((c.genMs || Infinity) < (a.genMs || Infinity) ? c : a));
    const rate = (r: V) => r.completionTokens / (r.genMs || r.durationMs || 1);
    const tput = done.reduce((a, c) => (rate(c) > rate(a) ? c : a));
    for (const v of done)
      best.set(keyOf(v), {
        fast: v === fast,
        ttft: v === ttft,
        gen: v === gen,
        cheap: v === cheap,
        tput: v === tput,
      });
  }

  // Review pages always open on Preview so you see the rendered result first.
  let viewMode: ViewMode = "preview";
  let scrollLink = localStorage.getItem(SCROLLLINK_KEY) === "1";
  const results = $("#results");
  const revealBtn = $("#reveal-models-btn");
  const summaryResults = () =>
    views.map((result) => ({
        key: keyOf(result),
        id: displayLabel(result),
        provider: concealed() ? undefined : result.provider,
        label: displayLabel(result),
        state: result.state,
        durationMs: result.durationMs,
        ttftMs: result.ttftMs,
        genMs: result.genMs,
        completionTokens: result.completionTokens,
        cost: result.cost,
        costKnown: result.costKnown,
        usageEstimated: result.usageEstimated,
        concealed: concealed(),
        metrics: result.metrics,
      }));
  function renderSummary() {
    const summary = summaryResults();
    $("#battle-summary-list").innerHTML = renderBattleSummary(summary);
    mountMetricsTimeline($("#battle-timeline"), summary);
    $("#battle-insights").innerHTML = renderBattleInsights(summary);
  }

  function cardHTML(v: V): string {
    const dot = v.state === "error" ? "bg-red-500" : "bg-emerald-400";
    const hasCode = v.state === "done" && !!v.code;
    const label = displayLabel(v);
    const resultContent =
      v.state === "error"
        ? `<div class="grid h-full place-items-center p-5 text-center"><div class="flex flex-col items-center gap-2 text-red-400/90">${svg("i-alert", "size-6")}<span class="max-w-[24rem] text-[12px] leading-relaxed">${esc(v.error || "Request failed.")}</span></div></div>`
        : doneContentHTML(
            { ...v, id: label, key: keyOf(v) },
            viewMode,
            {
              deferPreview:
                isPublicBattle && !activatedPreviews.has(keyOf(v)),
            },
          );
    const content =
      v.warning && v.state !== "error"
        ? `<div class="flex h-full min-h-0 flex-col">
            <div role="alert" class="flex items-start gap-2 border-b border-amber-400/25 bg-amber-400/10 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-200">
              ${svg("i-alert", "mt-0.5 size-3.5 shrink-0")}
              <span>${esc(v.warning)}</span>
            </div>
            <div class="min-h-0 flex-1">${resultContent}</div>
          </div>`
        : resultContent;
    const stats =
      v.state === "error"
        ? ""
        : statsRowHTML(
            {
              durationMs: v.durationMs,
              ttftMs: v.ttftMs,
              genMs: v.genMs,
              promptTokens: v.promptTokens,
              completionTokens: v.completionTokens,
              cost: v.cost,
              costKnown: v.costKnown,
              usageEstimated: v.usageEstimated,
            },
            { best: best.get(keyOf(v)) || {} },
          );
    return `
      <article class="result-card flex flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
        <div class="flex min-h-12 items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5">
          <span class="size-2 shrink-0 rounded-full ${dot}" aria-hidden="true"></span>
          <span class="sr-only">${v.state}</span>
          ${concealed() ? "" : modelBadge(v.provider, v.id)}
          <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]"${concealed() ? "" : ` title="${esc(v.id)}"`}>${esc(label)}</span>
          ${hasCode ? `<button data-action="open" data-model="${esc(keyOf(v))}" aria-label="Open preview in a new tab" class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]" title="open preview in new tab">${svg("i-expand", "size-4")}</button>` : ""}
        </div>
        <div class="bg-[var(--color-panel)]">${stats}</div>
        <div class="h-[clamp(20rem,50vh,38rem)] bg-[var(--color-surface)]">${content}</div>
      </article>`;
  }
  const revealIcon = $("#reveal-models-icon");
  const revealLabel = $("#reveal-models-label");
  const refreshRevealBtn = () => {
    const blind = !!b.blind?.enabled;
    revealBtn.classList.toggle("hidden", !blind);
    revealBtn.classList.toggle("flex", blind);
    revealBtn.setAttribute("aria-pressed", String(revealed));
    revealBtn.title = revealed ? "Hide model identities again" : "Reveal model identities";
    revealIcon.setAttribute("href", revealed ? "#i-eye-off" : "#i-eye");
    revealLabel.textContent = revealed ? "Hide" : "Reveal";
  };
  const renderAll = () => {
    results.innerHTML = views.map(cardHTML).join("");
    renderSummary();
    refreshRevealBtn();
  };
  renderAll();

  /* view tabs ----------------------------------------------------------- */
  const viewControls = $("#view-controls");
  function refreshTabs() {
    viewControls.querySelectorAll<HTMLElement>(".view-tab").forEach((tab) => {
      const on = tab.dataset.mode === viewMode;
      tab.classList.toggle("bg-[var(--color-panel-hi)]", on);
      tab.classList.toggle("text-[var(--color-accent)]", on);
      tab.classList.toggle("text-[var(--color-ink-dim)]", !on);
      tab.classList.toggle("hover:bg-[var(--color-panel-hi)]", !on);
      tab.classList.toggle("hover:text-[var(--color-ink)]", !on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
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
  viewControls.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...viewControls.querySelectorAll<HTMLElement>(".view-tab")];
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    setView(tabs[next].dataset.mode as ViewMode);
  });

  /* scroll link --------------------------------------------------------- */
  const scrollBtn = $("#scroll-link-btn");
  const scrollCheck = $("#scroll-link-check");
  function refreshScrollBtn() {
    scrollBtn.classList.toggle("border-[var(--color-accent)]", scrollLink);
    scrollBtn.classList.toggle("text-[var(--color-accent)]", scrollLink);
    scrollBtn.classList.toggle("text-[var(--color-ink-dim)]", !scrollLink);
    scrollBtn.setAttribute("aria-pressed", String(scrollLink));
    scrollCheck.classList.toggle("border-[var(--color-accent)]", scrollLink);
    scrollCheck.classList.toggle("bg-[var(--color-accent)]", scrollLink);
    scrollCheck.classList.toggle("text-black", scrollLink);
    scrollCheck.classList.toggle("border-[var(--color-line-hi)]", !scrollLink);
    scrollCheck.classList.toggle("text-transparent", !scrollLink);
  }
  function toggleScrollLink() {
    scrollLink = !scrollLink;
    localStorage.setItem(SCROLLLINK_KEY, scrollLink ? "1" : "0");
    refreshScrollBtn();
  }
  refreshScrollBtn();
  scrollBtn.addEventListener("click", toggleScrollLink);
  installScrollSync(() => scrollLink);

  revealBtn.addEventListener("click", () => {
    if (!b.blind?.enabled) return;
    revealed = !revealed;
    b.blind.revealed = revealed;
    const history = loadHistory();
    const saved = history.find((item) => item.id === b.id || item.ts === b.ts);
    if (saved?.blind) {
      saved.blind.revealed = revealed;
      saveHistory(history);
    }
    renderAll();
  });

  /* per-card actions ---------------------------------------------------- */
  results.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
    if (!btn) return;
    const v = views.find((x) => keyOf(x) === btn.dataset.model);
    if (!v) return;
    if (btn.dataset.action === "copy" && v.code) {
      await navigator.clipboard.writeText(v.code);
      play("success");
      const sp = btn.querySelector("span");
      if (sp) {
        const prev = sp.textContent;
        sp.textContent = "copied";
        setTimeout(() => (sp.textContent = prev), 1200);
      }
    } else if (btn.dataset.action === "run-preview" && v.code) {
      activatedPreviews.add(keyOf(v));
      const deferred = btn.closest("[data-deferred-preview]");
      if (deferred) {
        deferred.outerHTML = doneContentHTML(
          { ...v, id: displayLabel(v), key: keyOf(v) },
          "preview",
        );
      }
    } else if (btn.dataset.action === "reload-preview") {
      const f = btn
        .closest("article")
        ?.querySelector("iframe[data-preview]") as HTMLIFrameElement | null;
      if (f) restartPreview(f);
    } else if (btn.dataset.action === "view-code") {
      setView("code");
    } else if (btn.dataset.action === "open" && v.code) {
      openHardenedPreview(v.code, `Preview · ${displayLabel(v)}`);
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
      o: () => viewControls.querySelector<HTMLButtonElement>('[data-mode="output"]')?.click(),
      c: () => viewControls.querySelector<HTMLButtonElement>('[data-mode="code"]')?.click(),
      p: () => viewControls.querySelector<HTMLButtonElement>('[data-mode="preview"]')?.click(),
      l: () => scrollBtn.click(),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      fn();
    }
  });
}
