/* =========================================================================
   AI BATTLE — run one prompt across many OpenRouter models, compare results.
   All state (api key, prompt, selection) lives in the browser. No backend.
   ========================================================================= */
import {
  $,
  esc,
  svg,
  fmtDur,
  fmtCost,
  estTokens,
  extractCode,
  statsRowHTML,
  thoughtsHTML,
  doneContentHTML,
  loadHistory,
  saveHistory,
  fmtWhen,
  installScrollSync,
  SCROLLLINK_KEY,
  renderBattleSummary,
  renderMetricsTimeline,
  renderBattleInsights,
  downsampleMetricSamples,
  installMetricTooltips,
  installTimelineTracking,
  modelBadge,
  type Battle,
  type HistoryResult,
  type MetricSample,
  type ViewMode,
} from "./lib";
import { toSharedBattleData } from "./shared-battle";
import { PROVIDERS, PROVIDER_IDS, priceFor } from "./providers/registry";
import { SSEDecoder, type SSEEvent } from "./providers/sse";
import type { ModelInfo, ProviderId, UsageInfo } from "./providers/types";
import { play } from "cuelume";

const DEFAULT_SYSTEM_PROMPT = `You are competing in a head-to-head build challenge. Another AI receives the EXACT same request, and your answer is judged against theirs on quality, polish and correctness.

Respond in TWO parts, in this exact order:

1. A SHORT answer: 2-4 sentences describing your approach and any notable decisions. No fluff, no headings.

2. The complete solution as ONE self-contained HTML document inside a single \`\`\`html fenced code block. This document MUST:
   - Start with <!doctype html> and include <html>, <head> and <body>.
   - Put ALL CSS inside one <style> tag in the <head>.
   - Put ALL JavaScript inside one <script> tag (vanilla JS, no build step, no frameworks).
   - Make NO network requests: no CDNs, no imports, no external fonts, images or scripts. It must run fully offline inside a sandboxed iframe.
   - Use inline SVG instead of icon fonts/libraries. Use data: URIs only if an image is truly required.
   - Be polished, responsive, accessible and immediately runnable.

Output ONLY the short answer followed by the single \`\`\`html block. Write nothing after the closing fence.`;

// Contender identity = "<provider>::<modelId>".
const provKey = (p: ProviderId, id: string) => `${p}::${id}`;
const parseKey = (k: string) => {
  const i = k.indexOf("::");
  return { provider: k.slice(0, i) as ProviderId, id: k.slice(i + 2) };
};

// Default line-up (needs no key to list — OpenRouter). Falls back per provider.
const DEFAULT_CONTENDERS = [
  "openrouter::anthropic/claude-opus-4.8",
  "openrouter::openai/gpt-5.5",
  "openrouter::google/gemini-3.5-flash",
];
const OR_DEFAULTS = [
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.5",
  "google/gemini-3.5-flash",
  "deepseek/deepseek-chat-v3.1",
];
const MAX_CONTENDERS = 6;
const BRAND_KEYWORDS = ["claude", "openai/gpt", "gemini", "deepseek", "grok", "llama"];
const SKIP_VARIANT = /image|audio|tts|embed|video|vision|moderation|guard|free/i;

const LS = {
  models: "ab:models",
  system: "ab:system",
  prompt: "ab:prompt",
  view: "ab:view",
  scrollLink: SCROLLLINK_KEY,
  blind: "ab:blind",
};
const keyLS = (p: ProviderId) => `ab:key:${p}`;

interface Entry {
  id: string; // raw model id (e.g. "gpt-5.5")
  provider: ProviderId;
  key: string; // composite identity "<provider>::<id>" (entries Map key)
  state: "loading" | "streaming" | "done" | "error";
  raw: string;
  reasoning: string; // the model's streamed chain-of-thought
  code: string; // raw extracted HTML (used for preview + open-in-tab)
  codeHtml: string; // highlighted HTML markup (used for the code view)
  error: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number; // total time: request → finish
  genMs: number; // generation time: first token → finish
  ttftMs: number; // request → first token
  firstTokenAt?: number; // performance.now() when the first token arrived
  usageEstimated: boolean;
  costKnown: boolean;
  metrics: MetricSample[];
  cached: boolean;
  view?: ViewMode; // per-card view override (auto-set to preview on finish)
  waitingDismissed: boolean;
  prompt: string; // user prompt this result was generated for (for caching)
  system: string; // system prompt this result was generated for
  el: HTMLElement;
  timer?: number;
  startedAt: number;
}

/* --------------------------------- state --------------------------------- */
// Migrate the old single-key / bare-id format to the per-provider format.
(function migrate() {
  const oldKey = localStorage.getItem("ab:key");
  if (oldKey && !localStorage.getItem(keyLS("openrouter")))
    localStorage.setItem(keyLS("openrouter"), oldKey);
  try {
    const m = JSON.parse(localStorage.getItem(LS.models) || "[]");
    if (Array.isArray(m) && m.some((x: string) => !x.includes("::")))
      localStorage.setItem(
        LS.models,
        JSON.stringify(m.map((x: string) => (x.includes("::") ? x : provKey("openrouter", x)))),
      );
  } catch {}
})();

// All credentials default to empty — models are only listed for providers the
// user has actually configured. For `local`, the "credential" is the base URL.
const keys = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, localStorage.getItem(keyLS(provider)) || ""]),
) as Record<ProviderId, string>;
const keyFor = (p: ProviderId) => keys[p] || "";
const hasCreds = (p: ProviderId) => keyFor(p).trim() !== "";

// Local endpoints are derived from its base URL (stored in the key slot);
// every other provider uses its fixed URLs.
const trimBase = (u: string) => u.trim().replace(/\/+$/, "");
const modelsUrlFor = (p: ProviderId) =>
  p === "local" ? `${trimBase(keyFor("local"))}/models` : PROVIDERS[p].modelsUrl;
const chatUrlFor = (p: ProviderId) =>
  p === "local" ? `${trimBase(keyFor("local"))}/chat/completions` : PROVIDERS[p].chatUrl;

let viewMode = (localStorage.getItem(LS.view) as ViewMode) || "preview";
let scrollLink = localStorage.getItem(LS.scrollLink) === "1";
let blindMode = localStorage.getItem(LS.blind) === "1";
let revealed = !blindMode;
let blindOrder: string[] = [];
const blindAliases = new Map<string, string>();
let systemPrompt = localStorage.getItem(LS.system) || DEFAULT_SYSTEM_PROMPT;
let selected: string[] = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(LS.models) || "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((key): key is string => typeof key === "string"))].slice(
      0,
      MAX_CONTENDERS,
    );
  } catch {
    return [];
  }
})(); // composite keys
const providerModels = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, [] as ModelInfo[]]),
) as Record<ProviderId, ModelInfo[]>;
const catalog = new Map<string, ModelInfo>(); // composite key → model info
const loadedProviders = new Set<ProviderId>();
const providerErrors = new Map<ProviderId, string>();
type DropdownProvider = ProviderId | "all";
let dropdownProvider: DropdownProvider = "all";
const entries = new Map<string, Entry>(); // keyed by composite key
const controllers = new Map<string, AbortController>();
let running = false;
let currentBattleId: string | null = null;

/* --------------------------------- refs ---------------------------------- */
const els = {
  keyBtn: $("#key-btn"),
  keyDot: $("#key-dot"),
  keyModal: $("#key-modal"),
  keyBackdrop: $("#key-backdrop"),
  keySave: $("#key-save"),
  keyCancel: $("#key-cancel"),
  keyMessage: $("#key-modal-message"),
  chips: $("#models-chips"),
  addWrap: $("#add-model-wrap"),
  addBtn: $("#add-model-btn"),
  dropdown: $("#model-dropdown"),
  search: $<HTMLInputElement>("#model-search"),
  list: $("#model-list"),
  count: $("#model-count"),
  sysToggle: $("#sys-toggle"),
  sysChevron: $("#sys-chevron"),
  sysPanel: $("#sys-panel"),
  sysText: $<HTMLTextAreaElement>("#system-prompt"),
  sysReset: $("#sys-reset"),
  prompt: $<HTMLTextAreaElement>("#prompt"),
  promptShell: $("#prompt-shell"),
  promptError: $("#prompt-error"),
  promptExamples: $("#prompt-examples"),
  runBtn: $<HTMLButtonElement>("#run-btn"),
  rerunAllBtn: $<HTMLButtonElement>("#rerun-all-btn"),
  runLabel: $("#run-label"),
  runIcon: $("#run-icon"),
  runShortcut: $("#run-shortcut"),
  viewControls: $("#view-controls"),
  scrollBtn: $("#scroll-link-btn"),
  scrollCheck: $("#scroll-link-check"),
  blindBtn: $<HTMLButtonElement>("#blind-mode-btn"),
  blindIcon: $("#blind-mode-icon"),
  blindCheck: $("#blind-mode-check"),
  revealBtn: $<HTMLButtonElement>("#reveal-models-btn"),
  status: $("#battle-status"),
  summary: $("#battle-summary"),
  summaryList: $("#battle-summary-list"),
  timeline: $("#battle-timeline"),
  insights: $("#battle-insights"),
  sharePanel: $("#share-panel"),
  shareBtn: $<HTMLButtonElement>("#share-battle-btn"),
  shareStatus: $("#share-status"),
  results: $("#results"),
  empty: $("#empty-state"),
  resultsToolbarWrap: $("#results-toolbar-wrap"),
  historyBtn: $("#history-btn"),
  historyCount: $("#history-count"),
  historyDrawer: $("#history-drawer"),
  historyBackdrop: $("#history-backdrop"),
  historyPanel: $("#history-panel"),
  historyClose: $("#history-close"),
  historyClear: $("#history-clear"),
  historyList: $("#history-list"),
};

/* ===================================================================== */
/*  API KEYS — one per provider                                          */
/* ===================================================================== */
const anyKey = () => PROVIDER_IDS.some((p) => keyFor(p).trim());
let dialogReturnFocus: HTMLElement | null = null;
function refreshKeyUI() {
  const has = anyKey();
  els.keyDot.style.background = has ? "var(--color-ink-faint)" : "var(--color-accent)";
  els.keyDot.classList.toggle("animate-pulse", !has);
  for (const p of PROVIDER_IDS)
    $(`[data-provider-ready="${p}"]`)?.classList.toggle("hidden", !hasCreds(p));
}
function openKeyModal(message = "") {
  dialogReturnFocus = document.activeElement as HTMLElement | null;
  for (const p of PROVIDER_IDS) {
    const inp = $<HTMLInputElement>(`#api-key-${p}`);
    if (inp) inp.value = keyFor(p);
  }
  els.keyMessage.textContent = message;
  els.keyMessage.classList.toggle("hidden", !message);
  els.keyModal.classList.remove("hidden");
  setTimeout(() => $<HTMLInputElement>("#api-key-openrouter")?.focus(), 30);
}
function closeKeyModal() {
  els.keyModal.classList.add("hidden");
  dialogReturnFocus?.focus();
}
els.keyBtn.addEventListener("click", () => openKeyModal());
els.keyCancel.addEventListener("click", closeKeyModal);
els.keyBackdrop.addEventListener("click", closeKeyModal);
els.keySave.addEventListener("click", () => {
  for (const p of PROVIDER_IDS) {
    const inp = $<HTMLInputElement>(`#api-key-${p}`);
    const val = inp?.value.trim() || "";
    const changed = val !== keys[p];
    keys[p] = val;
    if (val) localStorage.setItem(keyLS(p), val);
    else localStorage.removeItem(keyLS(p));
    // Refresh additions and clear catalogs whose credential was removed.
    if (changed) loadProviderModels(p);
  }
  play("success");
  refreshKeyUI();
  syncRunBtn();
  closeKeyModal();
});
PROVIDER_IDS.forEach((p) => {
  $(`#api-key-${p}`)?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") els.keySave.dispatchEvent(new Event("click"));
  });
});

/* ===================================================================== */
/*  MODELS — per-provider catalogs, provider-tabbed picker, chips        */
/* ===================================================================== */
async function loadProviderModels(p: ProviderId) {
  const prov = PROVIDERS[p];
  if (!hasCreds(p)) {
    providerModels[p] = [];
    if (dropdownProvider === p || dropdownProvider === "all") renderModelList();
    return;
  }
  try {
    providerErrors.delete(p);
    // A GET carrying custom headers (Content-Type, auth…) is a non-simple
    // request and triggers a CORS preflight. `local` servers like LM Studio
    // don't answer OPTIONS with CORS headers, so we send a bare GET — no auth
    // is needed to list local models anyway.
    const res = await fetch(
      modelsUrlFor(p),
      p !== "local" ? { headers: prov.headers(keyFor(p)) } : {},
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    providerModels[p] = prov.parseModels(json).sort((a, b) => a.id.localeCompare(b.id));
    for (const m of providerModels[p]) catalog.set(provKey(p, m.id), m);
  } catch (error) {
    providerModels[p] = [];
    const message = error instanceof Error ? error.message : "Request failed";
    providerErrors.set(
      p,
      message === "Failed to fetch"
        ? "Browser access was blocked (likely CORS). Use this model through OpenRouter."
        : message,
    );
  }
  loadedProviders.add(p);
  renderChips(); // names may have resolved
  if (dropdownProvider === p || dropdownProvider === "all") renderModelList();
}

async function loadModels() {
  // Only load providers the user has configured — nothing is listed for a
  // provider without credentials (an API key, or a base URL for `local`).
  await Promise.all(PROVIDER_IDS.filter(hasCreds).map(loadProviderModels));
  // Seed a default line-up only once OpenRouter's catalog is available.
  if (selected.length === 0 && providerModels.openrouter.length) {
    selected = pickDefaults();
    persistSelection();
    renderChips();
  }
}

function pickDefaults(): string[] {
  const or = providerModels.openrouter;
  if (!or.length) return DEFAULT_CONTENDERS;
  const has = (id: string) => or.some((m) => m.id === id);
  const picks = OR_DEFAULTS.filter(has);
  for (const kw of BRAND_KEYWORDS) {
    if (picks.length >= 3) break;
    if (picks.some((id) => id.includes(kw.split("/").pop()!))) continue;
    const hit = or.find(
      (m) => m.id.includes(kw) && !m.id.startsWith("~") && !SKIP_VARIANT.test(m.id),
    );
    if (hit) picks.push(hit.id);
  }
  return picks.slice(0, 3).map((id) => provKey("openrouter", id));
}

function persistSelection() {
  localStorage.setItem(LS.models, JSON.stringify(selected));
}

function addSelection(key: string) {
  if (selected.includes(key) || selected.length >= MAX_CONTENDERS) return false;
  selected.push(key);
  return true;
}

const contenderName = (key: string) =>
  (catalog.get(key)?.name || parseKey(key).id).replace(/\s*\(.*?\)\s*$/, "");

// Cost estimate: catalog pricing when known, otherwise use the built-in table.
function costFor(entry: Entry, promptTokens: number, completionTokens: number): number | null {
  const cat = catalog.get(entry.key);
  if (cat && cat.promptPrice !== null && cat.completionPrice !== null)
    return promptTokens * cat.promptPrice + completionTokens * cat.completionPrice;
  const pr = priceFor(entry.provider, entry.id);
  return pr ? promptTokens * pr.prompt + completionTokens * pr.completion : null;
}

function priceLabel(m: ModelInfo) {
  if (m.promptPrice === null || m.completionPrice === null) return "";
  const i = (m.promptPrice * 1e6).toFixed(2);
  const o = (m.completionPrice * 1e6).toFixed(2);
  return `$${i}/M in · $${o}/M out`;
}

function renderChips() {
  els.count.textContent = String(selected.length);
  const limitReached = selected.length >= MAX_CONTENDERS;
  els.addBtn.title = limitReached
    ? `Maximum of ${MAX_CONTENDERS} models selected`
    : "add model · shortcut: M";
  els.addBtn.setAttribute(
    "aria-label",
    limitReached ? `Model limit reached (${MAX_CONTENDERS})` : "Add model",
  );
  [...els.chips.querySelectorAll(".model-chip")].forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  for (const key of selected) {
    const { provider, id } = parseKey(key);
    const chip = document.createElement("div");
    chip.className =
      "model-chip group flex min-h-10 items-center gap-1.5 rounded-xl border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] py-1.5 pl-2.5 pr-1.5 text-[12px] font-medium text-[var(--color-ink)] shadow-sm";
    chip.innerHTML = `
      ${modelBadge(provider, id)}
      <span class="max-w-[13rem] truncate" title="${esc(key)}">${esc(contenderName(key))}</span>
      <button data-remove="${esc(key)}" class="grid size-5 place-items-center rounded text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]" title="remove">
        ${svg("i-x", "size-3.5")}
      </button>`;
    frag.appendChild(chip);
  }
  els.chips.insertBefore(frag, els.addWrap);
  syncRunBtn();
}

els.chips.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-remove]") as HTMLElement;
  if (!btn) return;
  selected = selected.filter((k) => k !== btn.dataset.remove);
  persistSelection();
  renderChips();
  renderModelList();
});

function renderModelList() {
  // provider tab highlight
  els.dropdown.querySelectorAll<HTMLElement>("[data-provtab]").forEach((t) => {
    const on = t.dataset.provtab === dropdownProvider;
    t.classList.toggle("text-[var(--color-ink)]", on);
    t.classList.toggle("bg-[var(--color-panel-hi)]", on);
    t.classList.toggle("text-[var(--color-ink-faint)]", !on);
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  });

  const q = els.search.value.trim().toLowerCase();
  const qraw = els.search.value.trim();
  const visibleProviders =
    dropdownProvider === "all" ? PROVIDER_IDS.filter(hasCreds) : [dropdownProvider];
  const models = visibleProviders.flatMap((provider) =>
    providerModels[provider].map((model) => ({ provider, model })),
  );
  const matches = (q
    ? models.filter(
        ({ model }) =>
          model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q),
      )
    : models
  ).slice(0, 80);

  let html = "";
  if (dropdownProvider === "all") {
    if (!visibleProviders.length) {
      html += `<li class="px-3 py-6 text-center text-[11px] leading-relaxed text-[var(--color-ink-faint)]">Add a provider API key to search its models.<br/><button data-openkeys class="mt-2 text-[var(--color-accent)] underline-offset-2 hover:underline">add key</button></li>`;
    } else if (!models.length) {
      const loading = visibleProviders.some((provider) => !loadedProviders.has(provider));
      const failed = visibleProviders.some((provider) => providerErrors.has(provider));
      html += failed && !loading
        ? `<li class="px-3 py-6 text-center text-[11px] leading-relaxed text-red-400/90">Could not load models from the configured providers.<br/><button data-openkeys class="mt-2 text-[var(--color-accent)] underline-offset-2 hover:underline">check credentials</button></li>`
        : `<li class="px-3 py-6 text-center text-[var(--color-ink-faint)]">${loading ? "loading models…" : "no models"}</li>`;
    }
  } else {
    const prov = PROVIDERS[dropdownProvider];
    if (!hasCreds(dropdownProvider)) {
      const what = dropdownProvider === "local" ? "base URL" : "API key";
      const cta = dropdownProvider === "local" ? "set base URL" : "add key";
      html += `<li class="px-3 py-6 text-center text-[11px] leading-relaxed text-[var(--color-ink-faint)]">Set your ${esc(prov.name)} ${what} to list its models.<br/><button data-openkeys class="mt-2 text-[var(--color-accent)] underline-offset-2 hover:underline">${cta}</button></li>`;
    } else if (providerErrors.has(dropdownProvider)) {
      html += `<li class="px-3 py-6 text-center text-[11px] leading-relaxed text-red-400/90">${esc(providerErrors.get(dropdownProvider)!)}<br/><button data-openkeys class="mt-2 text-[var(--color-accent)] underline-offset-2 hover:underline">check credentials</button></li>`;
    } else if (!models.length) {
      html += `<li class="px-3 py-6 text-center text-[var(--color-ink-faint)]">${loadedProviders.has(dropdownProvider) ? "no models" : "loading models…"}</li>`;
    }
  }
  for (const { provider, model: m } of matches) {
    const key = provKey(provider, m.id);
    const on = selected.includes(key);
    const disabled = !on && selected.length >= MAX_CONTENDERS;
    const price = priceLabel(m);
    html += `
      <li>
        <button role="option" aria-selected="${on}" data-add="${esc(key)}" ${disabled ? 'disabled aria-disabled="true"' : ""} class="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${disabled ? "cursor-not-allowed opacity-40" : "hover:bg-[var(--color-panel-hi)]"}">
          <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${on ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-black" : "border-[var(--color-line-hi)] text-transparent"}">
            ${svg("i-check", "size-3")}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              ${modelBadge(provider, m.id)}
              <span class="block min-w-0 truncate text-[var(--color-ink)]">${esc(m.name)}</span>
            </span>
            <span class="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-ink-faint)]">${esc(m.id)}${price ? " · " + price : ""}</span>
          </span>
        </button>
      </li>`;
  }
  if (!matches.length && models.length && qraw) {
    html += `<li class="px-3 py-6 text-center text-[var(--color-ink-faint)]">no matches</li>`;
  }
  els.list.innerHTML = html;
}

els.list.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-openkeys]")) return openKeyModal();
  const btn = (e.target as HTMLElement).closest("[data-add]") as HTMLElement;
  if (!btn) return;
  const key = btn.dataset.add!;
  if (selected.includes(key)) selected = selected.filter((k) => k !== key);
  else if (!addSelection(key)) return;
  persistSelection();
  renderChips();
  renderModelList();
});

// provider tabs inside the dropdown
els.dropdown.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest("[data-provtab]") as HTMLElement;
  if (!tab) return;
  dropdownProvider = tab.dataset.provtab as DropdownProvider;
  els.search.value = "";
  if (dropdownProvider !== "all" && !loadedProviders.has(dropdownProvider))
    loadProviderModels(dropdownProvider);
  renderModelList();
});
els.dropdown.addEventListener("keydown", (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-provtab]");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...els.dropdown.querySelectorAll<HTMLElement>("[data-provtab]")];
  const current = tabs.indexOf(tab);
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
});

function toggleDropdown(open?: boolean) {
  const show = open ?? els.dropdown.classList.contains("hidden");
  els.dropdown.classList.toggle("hidden", !show);
  els.addBtn.setAttribute("aria-expanded", String(show));
  if (show) {
    els.search.value = "";
    if (dropdownProvider !== "all" && !loadedProviders.has(dropdownProvider))
      loadProviderModels(dropdownProvider);
    renderModelList();
    setTimeout(() => els.search.focus(), 20);
  }
}
els.addBtn.addEventListener("click", () => toggleDropdown());
els.search.addEventListener("input", renderModelList);
els.search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    els.list
      .querySelector<HTMLButtonElement>(
        "[data-add]:not(:disabled), [data-openkeys]:not(:disabled)",
      )
      ?.focus();
    return;
  }
  if (e.key === "Enter" && els.search.value.trim()) {
    e.preventDefault();
    els.list.querySelector<HTMLButtonElement>("[data-add]:not(:disabled)")?.click();
  }
});
els.list.addEventListener("keydown", (event) => {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const options = [
    ...els.list.querySelectorAll<HTMLButtonElement>(
      "[data-add]:not(:disabled), [data-openkeys]:not(:disabled)",
    ),
  ];
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  if (!options.length || current < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
  options[next].focus();
});
document.addEventListener("click", (e) => {
  if (!els.addWrap.contains(e.target as Node)) toggleDropdown(false);
});

/* ===================================================================== */
/*  SYSTEM PROMPT                                                         */
/* ===================================================================== */
els.sysText.value = systemPrompt;
els.sysToggle.addEventListener("click", () => {
  const hidden = els.sysPanel.classList.toggle("hidden");
  els.sysChevron.style.transform = hidden ? "rotate(-90deg)" : "";
  els.sysToggle.setAttribute("aria-expanded", String(!hidden));
});
els.sysChevron.style.transform = "rotate(-90deg)";
els.sysText.addEventListener("input", () => {
  systemPrompt = els.sysText.value;
  localStorage.setItem(LS.system, systemPrompt);
});
els.sysReset.addEventListener("click", () => {
  systemPrompt = DEFAULT_SYSTEM_PROMPT;
  els.sysText.value = systemPrompt;
  localStorage.setItem(LS.system, systemPrompt);
});

/* ===================================================================== */
/*  VIEW MODE                                                             */
/* ===================================================================== */
function refreshViewTabs() {
  els.viewControls.querySelectorAll<HTMLElement>(".view-tab").forEach((tab) => {
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
// Effective view for a card: its own override (auto-set to preview on finish)
// or the global view chosen via the tabs.
const viewOf = (e: Entry) => e.view ?? viewMode;

function setView(mode: ViewMode) {
  viewMode = mode;
  localStorage.setItem(LS.view, viewMode);
  refreshViewTabs();
  // A deliberate tab click applies to every card — drop per-card overrides.
  entries.forEach((entry) => {
    entry.view = undefined;
    renderContent(entry);
  });
}
els.viewControls.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest(".view-tab") as HTMLElement;
  if (tab) setView(tab.dataset.mode as ViewMode);
});
els.viewControls.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...els.viewControls.querySelectorAll<HTMLElement>(".view-tab")];
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

/* ----- scroll link: scroll every result pane together ------------------- */
function refreshToggleCheck(element: HTMLElement, active: boolean) {
  element.classList.toggle("border-[var(--color-accent)]", active);
  element.classList.toggle("bg-[var(--color-accent)]", active);
  element.classList.toggle("text-black", active);
  element.classList.toggle("border-[var(--color-line-hi)]", !active);
  element.classList.toggle("text-transparent", !active);
}
function refreshScrollBtn() {
  els.scrollBtn.classList.toggle("border-[var(--color-accent)]", scrollLink);
  els.scrollBtn.classList.toggle("text-[var(--color-accent)]", scrollLink);
  els.scrollBtn.classList.toggle("text-[var(--color-ink-dim)]", !scrollLink);
  els.scrollBtn.setAttribute("aria-pressed", String(scrollLink));
  refreshToggleCheck(els.scrollCheck, scrollLink);
}
function toggleScrollLink() {
  scrollLink = !scrollLink;
  localStorage.setItem(LS.scrollLink, scrollLink ? "1" : "0");
  refreshScrollBtn();
}
els.scrollBtn.addEventListener("click", toggleScrollLink);
installScrollSync(() => scrollLink);

/* ----- blind mode: shuffled anonymous cards until explicit reveal ------- */
const isConcealed = () => blindMode && !revealed;
const blindLabel = (key: string) => blindAliases.get(key) || "Model ?";
const displayName = (key: string) => (isConcealed() ? blindLabel(key) : contenderName(key));

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const j = Math.floor(random * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function setBlindOrder(order: string[]) {
  blindOrder = [...order];
  blindAliases.clear();
  order.forEach((key, index) => blindAliases.set(key, `Model ${String.fromCharCode(65 + index)}`));
}

function refreshBlindUI() {
  els.blindIcon.setAttribute("href", blindMode ? "#i-eye-off" : "#i-eye");
  els.blindBtn.classList.toggle("border-[var(--color-accent)]", blindMode);
  els.blindBtn.classList.toggle("text-[var(--color-accent)]", blindMode);
  els.blindBtn.classList.toggle("text-[var(--color-ink-dim)]", !blindMode);
  els.blindBtn.setAttribute("aria-pressed", String(blindMode));
  refreshToggleCheck(els.blindCheck, blindMode);
  els.blindBtn.disabled = running;
  const complete =
    entries.size > 0 &&
    [...entries.values()].every((entry) => entry.state === "done" || entry.state === "error");
  const canReveal = isConcealed() && complete && !running;
  els.revealBtn.classList.toggle("hidden", !canReveal);
  els.revealBtn.classList.toggle("flex", canReveal);
}

function rerenderIdentities() {
  entries.forEach((entry) => renderCard(entry));
  computeBests();
}

function toggleBlindMode() {
  if (running) return;
  blindMode = !blindMode;
  localStorage.setItem(LS.blind, blindMode ? "1" : "0");
  revealed = !blindMode;
  if (blindMode && entries.size) {
    setBlindOrder(shuffled([...entries.keys()]));
    blindOrder.forEach((key) => {
      const entry = entries.get(key);
      if (entry) els.results.appendChild(entry.el);
    });
  }
  refreshBlindUI();
  rerenderIdentities();
}
els.blindBtn.addEventListener("click", toggleBlindMode);

els.revealBtn.addEventListener("click", () => {
  revealed = true;
  if (currentBattleId) {
    const battle = history.find((item) => battleId(item) === currentBattleId);
    if (battle?.blind) {
      battle.blind.revealed = true;
      persistHistory();
    }
  }
  refreshBlindUI();
  rerenderIdentities();
  els.status.textContent = "Model identities revealed";
  els.status.classList.remove("hidden");
  setTimeout(() => {
    if (!running) els.status.classList.add("hidden");
  }, 2200);
});

/* ===================================================================== */
/*  PROMPT + RUN button enablement                                       */
/* ===================================================================== */
function syncPromptExamples() {
  const visible = els.prompt.value.length === 0;
  els.promptExamples.classList.toggle("opacity-100", visible);
  els.promptExamples.classList.toggle("translate-y-0", visible);
  els.promptExamples.classList.toggle("pointer-events-none", !visible);
  els.promptExamples.classList.toggle("translate-y-1", !visible);
  els.promptExamples.classList.toggle("opacity-0", !visible);
  els.promptExamples.toggleAttribute("inert", !visible);
  els.promptExamples.setAttribute("aria-hidden", String(!visible));
}

els.prompt.value = localStorage.getItem(LS.prompt) || "";
syncPromptExamples();
els.prompt.addEventListener("input", () => {
  localStorage.setItem(LS.prompt, els.prompt.value);
  const valid = els.prompt.value.trim().length > 0;
  if (valid) {
    els.promptShell.classList.remove("validation-error");
    els.promptError.classList.add("hidden");
    els.prompt.removeAttribute("aria-invalid");
  }
  syncPromptExamples();
  syncRunBtn();
});
els.promptExamples.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-prompt-example]",
  );
  if (!button?.dataset.promptExample) return;
  els.prompt.value = button.dataset.promptExample;
  els.prompt.dispatchEvent(new Event("input"));
  els.prompt.focus();
});
function syncRunBtn() {
  // Keep Run clickable so a first-time visitor can press it and be guided to
  // complete the next required step (see runBattle). Only block it mid-run.
  els.runBtn.disabled = running;
  if (!running) {
    const needsKey = !anyKey();
    const needsModel = !selected.length;
    const label = needsKey
      ? "Add key to start"
      : needsModel
        ? "Select model to start"
        : "Run battle";
    const icon = needsKey ? "#i-key" : needsModel ? "#i-plus" : "#i-play";
    els.runLabel.textContent = label;
    els.runIcon.innerHTML = `<use href="${icon}"></use>`;
    els.runShortcut.textContent = needsKey ? "K" : needsModel ? "M" : "⌘↵";
    els.runBtn.setAttribute("aria-label", label);
  }
  els.rerunAllBtn.disabled = running;
  els.blindBtn.disabled = running;
  // "Re-run all" only matters once there are results to refresh.
  els.rerunAllBtn.classList.toggle("hidden", entries.size === 0);
}
els.runBtn.addEventListener("click", (event) => {
  // Keep the guided model picker open when this outside click triggers it.
  if (anyKey() && !selected.length) {
    event.stopPropagation();
    toggleDropdown(true);
    return;
  }
  runBattle();
});
els.rerunAllBtn.addEventListener("click", () => runBattle(true));

/* ===================================================================== */
/*  KEYBOARD SHORTCUTS — single letters for fast navigation.             */
/*  Ignored while typing in a field (except ⌘/Ctrl+↵ and Escape).        */
/* ===================================================================== */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  // Escape: close whatever is open, else blur the focused field.
  if (e.key === "Escape") {
    if (!els.historyDrawer.classList.contains("hidden")) return closeHistory();
    if (!els.keyModal.classList.contains("hidden")) return closeKeyModal();
    if (!els.dropdown.classList.contains("hidden")) return toggleDropdown(false);
    if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur();
    return;
  }
  // ⌘/Ctrl+Enter runs from anywhere (including the prompt field).
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    els.runBtn.click();
    return;
  }
  // Single-letter shortcuts: skip while typing or when a modifier is held.
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const map: Record<string, () => void> = {
    o: () => els.viewControls.querySelector<HTMLButtonElement>('[data-mode="output"]')?.click(),
    c: () => els.viewControls.querySelector<HTMLButtonElement>('[data-mode="code"]')?.click(),
    p: () => els.viewControls.querySelector<HTMLButtonElement>('[data-mode="preview"]')?.click(),
    r: () => els.runBtn.click(),
    k: () => els.keyBtn.click(),
    m: () => els.addBtn.click(),
    s: () => els.sysToggle.click(),
    h: () => els.historyBtn.click(),
    l: () => els.scrollBtn.click(),
    b: () => els.blindBtn.click(),
    "/": () => els.prompt.focus(),
  };
  const fn = map[e.key.toLowerCase()];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const dialog = [els.keyModal, els.historyDrawer].find(
    (element) => !element.classList.contains("hidden"),
  );
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

/* ===================================================================== */
/*  CARD RENDERING                                                        */
/* ===================================================================== */
function statsRow(entry: Entry, best: Record<string, boolean> = {}) {
  if (entry.state !== "done" && entry.state !== "streaming") return "";
  if (entry.state === "streaming") {
    // No API token counts yet — estimate from the streamed text length.
    const out = estTokens(entry.raw);
    const now = performance.now();
    const total = now - entry.startedAt;
    const gen = entry.firstTokenAt != null ? now - entry.firstTokenAt : 0;
    const cost = costFor(entry, entry.promptTokens, out);
    return statsRowHTML(
      {
        durationMs: total,
        ttftMs: entry.firstTokenAt != null ? entry.firstTokenAt - entry.startedAt : 0,
        genMs: gen,
        promptTokens: entry.promptTokens,
        completionTokens: out,
        cost: cost ?? 0,
        costKnown: cost !== null,
        usageEstimated: true,
      },
      { live: true },
    );
  }
  return statsRowHTML(
    {
      durationMs: entry.durationMs,
      ttftMs: entry.ttftMs,
      genMs: entry.genMs,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      cost: entry.cost,
      costKnown: entry.costKnown,
      usageEstimated: entry.usageEstimated,
    },
    { best },
  );
}

function refreshLiveStats(entry: Entry) {
  const stats = entry.el.querySelector<HTMLElement>("[data-stats]");
  if (!stats) return;

  const template = document.createElement("template");
  template.innerHTML = statsRow(entry);
  const currentPills = [...stats.querySelectorAll<HTMLElement>("[data-metric-tooltip]")];
  const nextPills = [...template.content.querySelectorAll<HTMLElement>("[data-metric-tooltip]")];

  if (!currentPills.length || currentPills.length !== nextPills.length) {
    stats.replaceChildren(template.content);
    return;
  }

  currentPills.forEach((pill, index) => {
    const next = nextPills[index];
    const nextValue = next.querySelector<HTMLElement>("[data-metric-value]");
    const value = pill.querySelector<HTMLElement>("[data-metric-value]");
    if (nextValue && value) value.textContent = nextValue.textContent;
    pill.dataset.metricTooltip = next.dataset.metricTooltip;
    pill.setAttribute("aria-label", next.getAttribute("aria-label") || "");
  });
}

function dotColor(state: Entry["state"]) {
  if (state === "loading" || state === "streaming")
    return "bg-[var(--color-accent)] animate-pulse";
  if (state === "error") return "bg-red-500";
  return "bg-emerald-400";
}

function contentHTML(entry: Entry): string {
  if (entry.state === "loading") {
    return `
      <div class="grid h-full place-items-center text-[var(--color-ink-faint)]">
        <div class="flex flex-col items-center gap-3">
          <span class="block size-7 rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)] spin"></span>
          <span class="font-mono text-[11px] tabular-nums" data-elapsed>0.0s</span>
        </div>
      </div>`;
  }
  if (entry.state === "error") {
    return `
      <div class="grid h-full place-items-center p-5 text-center">
        <div class="flex flex-col items-center gap-2 text-red-400/90">
          ${svg("i-alert", "size-6")}
          <span class="max-w-[24rem] text-[12px] leading-relaxed">${esc(entry.error)}</span>
        </div>
      </div>`;
  }
  if (entry.state === "streaming") {
    // A streaming block always shows its reasoning + text as it arrives,
    // regardless of the selected view (code/preview need the finished doc).
    return `<div data-scroll class="result-scroll h-full overflow-auto p-3.5 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">${thoughtsHTML(entry.reasoning, true)}<div class="whitespace-pre-wrap break-words"><span data-stream>${esc(entry.raw)}</span><span class="caret"></span></div></div>`;
  }
  const view = viewOf(entry);
  const content = doneContentHTML({ ...entry, id: displayName(entry.key) }, view);
  const pendingPeers = [...entries.values()].filter(
    (peer) =>
      peer !== entry && (peer.state === "loading" || peer.state === "streaming"),
  ).length;
  if (view !== "output" || entry.waitingDismissed || pendingPeers === 0) return content;

  return `
    <div class="relative h-full">
      ${content}
      <div data-waiting-overlay role="status" aria-live="polite" class="absolute inset-0 z-20 grid place-items-center bg-[var(--color-surface)]/95 p-6 text-center backdrop-blur-sm">
        <button data-action="dismiss-waiting" data-model="${esc(entry.key)}" aria-label="Close waiting screen and view output" class="absolute right-3 top-3 grid size-8 place-items-center rounded-lg border border-[var(--color-line)] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-hi)] hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]" title="view output">
          ${svg("i-x", "size-4")}
        </button>
        <div class="flex max-w-sm flex-col items-center">
          <span class="mb-5 grid size-12 place-items-center rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            ${svg("i-check", "size-6")}
          </span>
          <p class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-accent)]">Model finished</p>
          <p class="mt-2 text-xl font-semibold text-[var(--color-ink)]">Completed in ${fmtDur(entry.durationMs)}</p>
          <p data-waiting-message class="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">Waiting for ${pendingPeers} other model${pendingPeers === 1 ? "" : "s"} to finish…</p>
          <p class="mt-1 text-[10px] text-[var(--color-ink-faint)]">Close this screen to view the output.</p>
        </div>
      </div>
    </div>`;
}

function renderContent(entry: Entry) {
  const slot = entry.el.querySelector("[data-content]") as HTMLElement;
  if (slot) slot.innerHTML = contentHTML(entry);
}

function syncWaitingOverlays() {
  entries.forEach((entry) => {
    const overlay = entry.el.querySelector("[data-waiting-overlay]");
    const pendingPeers = [...entries.values()].filter(
      (peer) =>
        peer !== entry && (peer.state === "loading" || peer.state === "streaming"),
    ).length;
    if (overlay && (pendingPeers === 0 || viewOf(entry) !== "output")) {
      overlay.remove();
      return;
    }
    const message = overlay?.querySelector("[data-waiting-message]");
    if (message)
      message.textContent = `Waiting for ${pendingPeers} other model${pendingPeers === 1 ? "" : "s"} to finish…`;
  });
}

function renderCard(entry: Entry, best: Record<string, boolean> = {}) {
  const hasCode = entry.state === "done" && !!entry.code;
  const concealed = isConcealed();
  const name = displayName(entry.key);
  entry.el.innerHTML = `
    <div class="flex min-h-12 items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5">
      <span class="size-2 shrink-0 rounded-full ${dotColor(entry.state)}" aria-hidden="true"></span>
      <span class="sr-only">${entry.state}</span>
      ${concealed ? "" : modelBadge(entry.provider, entry.id)}
      <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]"${concealed ? "" : ` title="${esc(entry.key)}"`}>${esc(name)}</span>
      ${entry.cached ? `<span class="rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">cached</span>` : ""}
      ${
        hasCode
          ? `<button data-action="open" data-model="${esc(entry.key)}" aria-label="Open preview in a new tab" class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]" title="open preview in new tab">${svg("i-expand", "size-4")}</button>`
          : ""
      }
      <button data-action="rerun" data-model="${esc(entry.key)}" aria-label="Re-run ${esc(name)}" ${entry.state === "loading" || entry.state === "streaming" ? "disabled" : ""} class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-40" title="re-run this model">${svg("i-refresh", "size-4")}</button>
    </div>
    <div data-stats class="bg-[var(--color-panel)]">${statsRow(entry, best)}</div>
    <div data-content class="h-[clamp(20rem,50vh,38rem)] bg-[var(--color-surface)]"></div>`;
  renderContent(entry);
}

/* ===================================================================== */
/*  RUN                                                                   */
/* ===================================================================== */
function newCard(key: string): Entry {
  const { provider, id } = parseKey(key);
  const el = document.createElement("article");
  el.className =
    "result-card flex flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]";
  el.dataset.card = key;
  const entry: Entry = {
    id,
    provider,
    key,
    state: "loading",
    raw: "",
    reasoning: "",
    code: "",
    codeHtml: "",
    error: "",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    durationMs: 0,
    genMs: 0,
    ttftMs: 0,
    usageEstimated: true,
    costKnown: false,
    metrics: [],
    cached: false,
    waitingDismissed: false,
    prompt: "",
    system: "",
    el,
    startedAt: performance.now(),
  };
  return entry;
}

function recordMetricSample(entry: Entry, final = false) {
  const tMs = final ? entry.durationMs : performance.now() - entry.startedAt;
  let last = entry.metrics.at(-1);
  if (!final && last && tMs - last.tMs < 250) return false;
  if (final && last) {
    const tokenScale =
      last.completionTokens > 0 ? entry.completionTokens / last.completionTokens : 1;
    const costScale = last.costKnown && last.cost > 0 && entry.costKnown ? entry.cost / last.cost : 1;
    entry.metrics = entry.metrics.map((sample) => ({
      ...sample,
      completionTokens: Math.round(sample.completionTokens * tokenScale),
      cost: sample.cost * costScale,
    }));
    last = entry.metrics.at(-1);
  }
  const completionTokens = final ? entry.completionTokens : estTokens(entry.raw);
  const calculatedCost = final
    ? entry.costKnown
      ? entry.cost
      : null
    : costFor(entry, entry.promptTokens, completionTokens);
  const sample: MetricSample = {
    tMs: Math.max(0, tMs),
    completionTokens,
    cost: calculatedCost ?? 0,
    costKnown: calculatedCost !== null,
    estimated: final ? entry.usageEstimated : true,
  };
  if (final && last && Math.abs(last.tMs - sample.tMs) < 1) entry.metrics[entry.metrics.length - 1] = sample;
  else entry.metrics.push(sample);
  entry.metrics = downsampleMetricSamples(entry.metrics);
  return true;
}

// Live update loop: ticks the loading clock, pumps streamed text into the
// output panel, and refreshes the stat pills (tokens rising, cost estimate).
function flush(entry: Entry) {
  const elapsed = entry.el.querySelector("[data-elapsed]");
  if (elapsed)
    elapsed.textContent = `${((performance.now() - entry.startedAt) / 1000).toFixed(1)}s`;
  if (entry.state !== "streaming") return;
  if (entry.reasoning) {
    const rdiv = entry.el.querySelector("[data-reasoning]");
    if (rdiv) rdiv.textContent = entry.reasoning;
    entry.el.querySelector("[data-thoughts]")?.classList.remove("hidden");
  }
  const span = entry.el.querySelector("[data-stream]");
  if (span) span.textContent = entry.raw;
  const scroll = entry.el.querySelector("[data-scroll]") as HTMLElement | null;
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
  refreshLiveStats(entry);
  if (recordMetricSample(entry)) refreshTimeline();
}
function startTimer(entry: Entry) {
  entry.startedAt = performance.now();
  entry.timer = window.setInterval(() => flush(entry), 80);
}
function stopTimer(entry: Entry) {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = undefined;
}

async function callModel(entry: Entry) {
  const prov = PROVIDERS[entry.provider];
  const key = keyFor(entry.provider);
  // Stamp the exact prompt/system used so a later run can skip re-calling this
  // model when nothing changed (see reconcile in runBattle).
  const usedPrompt = els.prompt.value.trim();
  const usedSystem = systemPrompt;
  entry.prompt = usedPrompt;
  entry.system = usedSystem;
  entry.state = "loading";
  entry.raw = "";
  entry.reasoning = "";
  entry.code = entry.codeHtml = entry.error = "";
  entry.firstTokenAt = undefined;
  entry.promptTokens = 0;
  entry.completionTokens = 0;
  entry.totalTokens = 0;
  entry.cost = 0;
  entry.durationMs = 0;
  entry.genMs = 0;
  entry.ttftMs = 0;
  entry.usageEstimated = true;
  entry.costKnown = false;
  entry.metrics = [];
  entry.cached = false;
  entry.view = undefined;
  entry.waitingDismissed = false;
  renderCard(entry);

  // No credential for this provider → fail fast with a helpful message.
  if (!key.trim()) {
    entry.state = "error";
    entry.durationMs = 0;
    entry.error =
      entry.provider === "local"
        ? "Set your Local API base URL to run this model."
        : `Add your ${prov.name} API key to run this model.`;
    renderCard(entry);
    return;
  }
  startTimer(entry);
  controllers.get(entry.key)?.abort();
  const controller = new AbortController();
  controllers.set(entry.key, controller);
  try {
    const res = await fetch(chatUrlFor(entry.provider), {
      method: "POST",
      headers: prov.headers(key),
      body: JSON.stringify(prov.body(entry.id, usedSystem, usedPrompt)),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as {
          error?: string | { message?: string };
        };
        msg =
          (typeof j.error === "string" ? j.error : j.error?.message) || msg;
      } catch {}
      throw new Error(msg);
    }

    // Streaming has begun — flip to the live view.
    entry.state = "streaming";
    entry.promptTokens = estTokens(usedSystem + usedPrompt);
    const initialCost = costFor(entry, entry.promptTokens, 0);
    entry.metrics = [
      {
        tMs: 0,
        completionTokens: 0,
        cost: initialCost ?? 0,
        costKnown: initialCost !== null,
        estimated: true,
      },
    ];
    renderCard(entry);
    refreshTimeline();

    const reader = res.body.getReader();
    const textDecoder = new TextDecoder();
    const sse = new SSEDecoder();
    let usage: UsageInfo = {};
    let streamError: string | null = null;
    const processEvents = (events: SSEEvent[]): boolean => {
      for (const event of events) {
        const data = event.data.trim();
        if (data === "[DONE]") return true;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error || json.type === "error" || event.event === "error") {
          streamError = json.error?.message || json.error || json.message || "stream error";
          return true;
        }
        const parsed = prov.parse(json);
        if (parsed.reasoning || parsed.content) {
          if (entry.firstTokenAt == null) {
            entry.firstTokenAt = performance.now();
            entry.ttftMs = entry.firstTokenAt - entry.startedAt;
          }
          entry.reasoning += parsed.reasoning;
          entry.raw += parsed.content;
        }
        if (parsed.usage) usage = { ...usage, ...parsed.usage };
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        processEvents(sse.finish(textDecoder.decode()));
        break;
      }
      const shouldStop = processEvents(sse.push(textDecoder.decode(value, { stream: true })));
      if (shouldStop) {
        await reader.cancel();
        break;
      }
    }

    const end = performance.now();
    entry.durationMs = end - entry.startedAt;
    entry.genMs = entry.firstTokenAt != null ? end - entry.firstTokenAt : entry.durationMs;
    entry.ttftMs =
      entry.firstTokenAt != null ? entry.firstTokenAt - entry.startedAt : entry.durationMs;
    if (streamError && !entry.raw) throw new Error(streamError);

    entry.code = extractCode(entry.raw);
    if (entry.code) {
      const { highlightCode } = await import("./code-render");
      entry.codeHtml = highlightCode(entry.code);
    }
    entry.usageEstimated =
      typeof usage.completion_tokens !== "number" || typeof usage.prompt_tokens !== "number";
    // The API's completion_tokens already includes reasoning; our fallback
    // estimate must add it too so throughput isn't understated.
    entry.completionTokens = usage.completion_tokens ?? estTokens(entry.reasoning + entry.raw);
    entry.promptTokens = usage.prompt_tokens ?? entry.promptTokens;
    entry.totalTokens =
      usage.total_tokens ?? entry.promptTokens + entry.completionTokens;
    const calculatedCost =
      typeof usage.cost === "number"
        ? usage.cost
        : costFor(entry, entry.promptTokens, entry.completionTokens);
    entry.costKnown = calculatedCost !== null;
    entry.cost = calculatedCost ?? 0;

    entry.state = entry.raw ? "done" : "error";
    if (!entry.raw) entry.error = streamError || "Model returned an empty response.";
  } catch (err: unknown) {
    entry.durationMs = performance.now() - entry.startedAt;
    entry.genMs = entry.firstTokenAt != null ? performance.now() - entry.firstTokenAt : entry.durationMs;
    entry.ttftMs =
      entry.firstTokenAt != null ? entry.firstTokenAt - entry.startedAt : entry.durationMs;
    entry.state = "error";
    entry.completionTokens = estTokens(entry.raw);
    entry.totalTokens = entry.promptTokens + entry.completionTokens;
    const calculatedCost = costFor(entry, entry.promptTokens, entry.completionTokens);
    entry.costKnown = calculatedCost !== null;
    entry.cost = calculatedCost ?? 0;
    const message = err instanceof Error ? err.message : "Request failed.";
    entry.error =
      message === "Failed to fetch"
        ? `Browser access to ${prov.name} was blocked (likely CORS). Try the same model through OpenRouter.`
        : message === "This operation was aborted"
          ? "Request cancelled."
          : message;
  } finally {
    if (controllers.get(entry.key) === controller) controllers.delete(entry.key);
    stopTimer(entry);
    if (entry.state === "done" || entry.metrics.length) recordMetricSample(entry, true);
    renderCard(entry);
    syncWaitingOverlays();
    refreshComparison();
  }
}

function summaryEntries() {
  return [...entries.values()].map((entry) => {
    const latest = entry.metrics.at(-1);
    const live = entry.state === "streaming";
    return {
      key: entry.key,
      id: displayName(entry.key),
      provider: isConcealed() ? undefined : entry.provider,
      label: displayName(entry.key),
      state: entry.state,
      durationMs: live ? performance.now() - entry.startedAt : entry.durationMs,
      ttftMs: entry.ttftMs,
      genMs: entry.genMs,
      completionTokens: live ? latest?.completionTokens || 0 : entry.completionTokens,
      cost: live ? latest?.cost || 0 : entry.cost,
      costKnown: live ? latest?.costKnown : entry.costKnown,
      usageEstimated: live || entry.usageEstimated,
      cached: entry.cached,
      concealed: isConcealed(),
      metrics: entry.metrics,
    };
  });
}

function refreshProgress() {
  const all = [...entries.values()];
  const complete = all.filter((entry) => entry.state === "done" || entry.state === "error").length;
  els.status.textContent = running ? `${complete} of ${all.length} complete` : "";
  els.status.classList.toggle("hidden", !running);
}

function refreshComparison() {
  const results = summaryEntries();
  els.summary.classList.toggle("hidden", results.length === 0);
  els.summaryList.innerHTML = renderBattleSummary(results);
  refreshTimeline(results);
  refreshProgress();
  refreshBlindUI();
}

function refreshTimeline(results = summaryEntries()) {
  els.timeline.innerHTML = renderMetricsTimeline(results);
  els.insights.innerHTML = renderBattleInsights(results);
}

function computeBests() {
  const done = [...entries.values()].filter((e) => e.state === "done");
  if (done.length < 2) {
    refreshComparison();
    return;
  }
  const rate = (e: Entry) => e.completionTokens / (e.genMs || e.durationMs || 1);
  const knownCosts = done.filter((entry) => entry.costKnown);
  const best = {
    fast: done.reduce((a, b) => (b.durationMs < a.durationMs ? b : a)),
    ttft: done.reduce((a, b) => (b.ttftMs < a.ttftMs ? b : a)),
    gen: done.reduce((a, b) => (b.genMs < a.genMs ? b : a)),
    cheap: knownCosts.length
      ? knownCosts.reduce((a, b) => (b.cost < a.cost ? b : a))
      : null,
    tput: done.reduce((a, b) => (rate(b) > rate(a) ? b : a)),
  };
  for (const e of done) {
    renderCard(e, {
      fast: e === best.fast,
      ttft: e === best.ttft,
      gen: e === best.gen,
      cheap: e === best.cheap,
      tput: e === best.tput,
    });
  }
  refreshComparison();
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.allSettled(runners);
}

// force = true re-runs every selected model (ignores the cache). Otherwise we
// reuse any result already computed for this exact prompt + system prompt and
// only call the models that are new, stale, or errored — saving tokens.
async function runBattle(force = false) {
  if (running) return;
  // Guide the user instead of silently doing nothing.
  if (!anyKey()) return openKeyModal("Add at least one API key to get started.");
  if (!selected.length) return toggleDropdown(true);
  const neededProviders = [...new Set(selected.map((k) => parseKey(k).provider))];
  if (!neededProviders.every((p) => keyFor(p).trim())) return openKeyModal();
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    els.promptShell.classList.add("validation-error");
    els.promptError.classList.remove("hidden");
    els.prompt.setAttribute("aria-invalid", "true");
    els.prompt.focus();
    return;
  }
  els.promptShell.classList.remove("validation-error");
  els.promptError.classList.add("hidden");
  els.prompt.removeAttribute("aria-invalid");

  // Prewarm the formatter/highlighter chunk while models stream, so it's
  // already resolved when the first result finishes.
  import("./code-render");

  els.empty.classList.add("hidden");
  els.resultsToolbarWrap.classList.remove("hidden");
  currentBattleId = null;
  resetSharePanel();
  const runOrder = blindMode ? shuffled(selected) : [...selected];
  revealed = !blindMode;
  setBlindOrder(runOrder);

  // Drop cards for models that are no longer selected.
  for (const [id, e] of [...entries]) {
    if (!selected.includes(id)) {
      e.el.remove();
      entries.delete(id);
    }
  }

  // Reconcile: keep fresh results, (re)build everything that needs a call.
  const toRun: Entry[] = [];
  let reused = 0;
  for (const id of runOrder) {
    const cur = entries.get(id);
    const canReuse =
      !force &&
      cur &&
      cur.state === "done" &&
      cur.prompt === prompt &&
      cur.system === systemPrompt;
    if (canReuse) {
      els.results.appendChild(cur!.el); // reorder to selection order
      cur!.cached = true;
      reused++;
      continue;
    }
    if (cur) cur.el.remove();
    const entry = newCard(id);
    entries.set(id, entry);
    els.results.appendChild(entry.el);
    renderCard(entry);
    toRun.push(entry);
  }

  requestAnimationFrame(() => {
    els.results.querySelector<HTMLElement>(".result-card")?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  });

  if (!toRun.length) {
    play("success");
    computeBests(); // everything was cached — no API calls made
    return;
  }

  running = true;
  els.results.setAttribute("aria-busy", "true");
  syncRunBtn();
  if (!reused) setView("output"); // full run: jump to Output to watch streaming
  els.runLabel.textContent = "Running…";
  els.runIcon.innerHTML = `<use href="#i-refresh"></use>`;
  els.runIcon.classList.add("spin");
  refreshComparison();

  await runWithConcurrency(toRun, 3, callModel);

  running = false;
  els.results.setAttribute("aria-busy", "false");
  if (toRun.some((entry) => entry.state === "done")) play("success");
  els.runLabel.textContent = "Run battle";
  els.runIcon.innerHTML = `<use href="#i-play"></use>`;
  els.runIcon.classList.remove("spin");
  if (viewMode === "output" && [...entries.values()].some((entry) => entry.code))
    setView("preview");
  computeBests();
  saveBattle();
  syncRunBtn();
}

/* ---- per-card actions (copy / rerun / open) ----------------------------- */
els.results.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement;
  if (!btn) return;
  const entry = entries.get(btn.dataset.model!);
  if (!entry) return;
  const action = btn.dataset.action;

  if (action === "copy" && entry.code) {
    await navigator.clipboard.writeText(entry.code);
    play("success");
    const span = btn.querySelector("span");
    if (span) {
      const prev = span.textContent;
      span.textContent = "copied";
      setTimeout(() => (span.textContent = prev), 1200);
    }
  } else if (action === "reload-preview") {
    // Restart the demo without spending tokens — just reload the iframe.
    const f = entry.el.querySelector("iframe[data-preview]") as HTMLIFrameElement | null;
    if (f) f.srcdoc = f.srcdoc;
  } else if (action === "dismiss-waiting") {
    entry.waitingDismissed = true;
    btn.closest("[data-waiting-overlay]")?.remove();
  } else if (action === "rerun") {
    if (!keyFor(entry.provider).trim()) return openKeyModal();
    await callModel(entry);
    computeBests();
  } else if (action === "open" && entry.code) {
    const blob = new Blob([entry.code], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
});

/* ===================================================================== */
/*  HISTORY — every battle is archived to localStorage; entries link to    */
/*  the /battle detail route for review.                                  */
/* ===================================================================== */
let history: Battle[] = loadHistory();
let battleSeq = 0;
const battleId = (b: Battle) => b.id || String(b.ts);
const publicBattleUrl = (id: string) => {
  const url = new URL("/battle", location.origin);
  url.searchParams.set("id", id);
  return url.toString();
};

function persistHistory() {
  history = saveHistory(history);
  updateHistoryCount();
}

function resetSharePanel() {
  els.sharePanel.classList.add("hidden");
  els.shareStatus.classList.add("hidden");
  els.shareStatus.textContent = "";
  els.shareBtn.disabled = false;
  els.shareBtn.querySelector("span")!.textContent = "Publish results";
  els.shareBtn.querySelector("use")!.setAttribute("href", "#i-world");
}

function showSharePanel(battle: Battle) {
  if (!battle.results.some((result) => result.state === "done")) {
    resetSharePanel();
    return;
  }
  els.sharePanel.classList.remove("hidden");
  els.shareBtn.disabled = false;
  if (!battle.sharedId) {
    els.shareStatus.classList.add("hidden");
    els.shareStatus.textContent = "";
    els.shareBtn.querySelector("span")!.textContent = "Publish results";
    els.shareBtn.querySelector("use")!.setAttribute("href", "#i-world");
    return;
  }
  const url = publicBattleUrl(battle.sharedId);
  els.shareStatus.className = "mt-2 text-[11px] text-emerald-400";
  els.shareStatus.innerHTML = `Published. <a class="underline underline-offset-2 hover:text-emerald-300" href="${esc(url)}" target="_blank" rel="noopener">Open public battle</a>`;
  els.shareBtn.querySelector("span")!.textContent = "Copy link";
  els.shareBtn.querySelector("use")!.setAttribute("href", "#i-copy");
}

async function copyPublicBattleUrl(id: string) {
  await navigator.clipboard.writeText(publicBattleUrl(id));
  play("success");
  els.shareStatus.className = "mt-2 text-[11px] text-emerald-400";
  els.shareStatus.textContent = "Public link copied to your clipboard.";
}

els.shareBtn.addEventListener("click", async () => {
  const battle = history.find((item) => battleId(item) === currentBattleId);
  if (!battle) return;
  if (battle.sharedId) {
    try {
      await copyPublicBattleUrl(battle.sharedId);
    } catch {
      showSharePanel(battle);
    }
    return;
  }

  els.shareBtn.disabled = true;
  els.shareBtn.querySelector("span")!.textContent = "Publishing…";
  els.shareStatus.className = "mt-2 text-[11px] text-[var(--color-ink-faint)]";
  els.shareStatus.textContent = "Uploading the public results…";
  try {
    const response = await fetch("/api/battles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toSharedBattleData(battle)),
    });
    const data = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !data.id)
      throw new Error(data.error || "Could not publish this battle.");
    battle.sharedId = data.id;
    persistHistory();
    showSharePanel(battle);
    try {
      await copyPublicBattleUrl(data.id);
    } catch {
      showSharePanel(battle);
    }
  } catch (error) {
    els.shareBtn.disabled = false;
    els.shareBtn.querySelector("span")!.textContent = "Try again";
    els.shareStatus.className = "mt-2 text-[11px] text-red-400";
    els.shareStatus.textContent =
      error instanceof Error ? error.message : "Could not publish this battle.";
  }
});

function updateHistoryCount() {
  const n = history.length;
  els.historyCount.textContent = String(n);
  els.historyCount.classList.toggle("hidden", n === 0);
  els.historyClear.classList.toggle("hidden", n === 0);
  els.historyClear.classList.toggle("flex", n > 0);
}

function saveBattle() {
  const results: HistoryResult[] = [...entries.values()]
    .filter((e) => e.state === "done" || e.state === "error")
    .map((e) => ({
      id: e.id,
      key: e.key,
      provider: e.provider,
      label: contenderName(e.key),
      raw: e.raw,
      reasoning: e.reasoning,
      code: e.code,
      state: e.state === "error" ? "error" : "done",
      error: e.error,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      totalTokens: e.totalTokens,
      cost: e.cost,
      costKnown: e.costKnown,
      usageEstimated: e.usageEstimated,
      durationMs: e.durationMs,
      ttftMs: e.ttftMs,
      genMs: e.genMs,
      metrics: downsampleMetricSamples(e.metrics),
    }));
  if (!results.length) return;
  const ts = Date.now();
  currentBattleId = `${ts}-${(battleSeq++).toString(36)}`;
  const battle: Battle = {
    id: currentBattleId,
    schemaVersion: 3,
    ts,
    prompt: els.prompt.value.trim(),
    system: systemPrompt,
    results,
    blind: blindMode
      ? {
          enabled: true,
          revealed,
          order: [...blindOrder],
          aliases: Object.fromEntries(blindAliases),
        }
      : undefined,
  };
  history.unshift(battle);
  persistHistory();
  showSharePanel(battle);
}

function renderHistory() {
  if (!history.length) {
    els.historyList.innerHTML = `
      <div class="grid h-full place-items-center px-6 text-center">
        <div class="flex flex-col items-center gap-3 text-[var(--color-ink-faint)]">
          <svg class="size-7"><use href="#i-history"></use></svg>
          <p class="text-[12px] leading-relaxed">No battles yet.<br/>Run one and it'll be saved here.</p>
        </div>
      </div>`;
    return;
  }
  els.historyList.innerHTML = history
    .map((b) => {
      const id = battleId(b);
      const ok = b.results.filter((r) => r.state === "done");
      const fastest = ok.length
        ? ok.reduce((a, c) => (c.durationMs < a.durationMs ? c : a))
        : null;
      const knownCosts = ok.filter((result) => result.costKnown !== false);
      const cheapest = knownCosts.length
        ? knownCosts.reduce((a, c) => (c.cost < a.cost ? c : a))
        : null;
      const concealed = !!b.blind?.enabled && !b.blind.revealed;
      const lbl = (r: HistoryResult) => {
        const key = r.key || `${r.provider || "openrouter"}::${r.id}`;
        return esc(concealed ? b.blind?.aliases[key] || "Model ?" : r.label || r.id);
      };
      const chips = b.results
        .map(
          (r) => `
        <span class="inline-flex items-center gap-1 rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] ${r.state === "error" ? "text-red-400/80" : "text-[var(--color-ink-dim)]"}">
          ${!concealed && r.provider ? modelBadge(r.provider, r.id) : `<span class="size-1 rounded-full ${r.state === "error" ? "bg-red-500" : "bg-emerald-400"}"></span>`}${lbl(r)}
        </span>`,
        )
        .join("");
      return `
      <div class="group relative mb-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-line-hi)]">
       <a href="/battle?id=${encodeURIComponent(id)}" class="block p-3 pr-11">
        <div class="flex items-center justify-between gap-2 pr-8">
          <span class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            <svg class="size-3"><use href="#i-clock"></use></svg>${fmtWhen(b.ts)}
            ${concealed ? `<span class="rounded border border-[var(--color-accent)]/30 px-1 py-0.5 text-[8px] text-[var(--color-accent)]">blind</span>` : ""}
          </span>
          <span class="flex items-center gap-1 text-[10px] text-[var(--color-ink-dim)]"><svg class="size-3.5"><use href="#i-restore"></use></svg>open</span>
        </div>
        <p class="mt-2 line-clamp-2 text-[12px] text-[var(--color-ink)]">${b.prompt ? esc(b.prompt) : '<span class="text-[var(--color-ink-faint)]">(empty prompt)</span>'}</p>
        <div class="mt-2 flex flex-wrap gap-1">${chips}</div>
        ${
          ok.length
            ? `<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-ink-faint)]">
                <span class="inline-flex items-center gap-1"><svg class="size-3"><use href="#i-clock"></use></svg>${fmtDur(fastest!.durationMs)} · ${lbl(fastest!)}</span>
                ${cheapest ? `<span class="inline-flex items-center gap-1"><svg class="size-3"><use href="#i-coin"></use></svg>${fmtCost(cheapest.cost)} · ${lbl(cheapest)}</span>` : ""}
              </div>`
            : ""
        }
       </a>
       <button data-del="${esc(id)}" aria-label="Delete battle" class="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-red-400" title="delete">
         <svg class="size-3.5"><use href="#i-trash"></use></svg>
       </button>
      </div>`;
    })
    .join("");
}

function deleteBattle(id: string) {
  if (!window.confirm("Delete this battle from local history?")) return;
  history = history.filter((b) => battleId(b) !== id);
  persistHistory();
  renderHistory();
}
function clearHistory() {
  if (!window.confirm("Clear every saved battle from this browser?")) return;
  history = [];
  persistHistory();
  renderHistory();
}
function openHistory() {
  dialogReturnFocus = document.activeElement as HTMLElement | null;
  renderHistory();
  els.historyDrawer.classList.remove("hidden");
  requestAnimationFrame(() => els.historyPanel.classList.remove("translate-x-full"));
  setTimeout(() => els.historyClose.focus(), 30);
}
function closeHistory() {
  els.historyPanel.classList.add("translate-x-full");
  setTimeout(() => els.historyDrawer.classList.add("hidden"), 300);
  dialogReturnFocus?.focus();
}
els.historyBtn.addEventListener("click", openHistory);
els.historyClose.addEventListener("click", closeHistory);
els.historyBackdrop.addEventListener("click", closeHistory);
els.historyClear.addEventListener("click", clearHistory);
els.historyList.addEventListener("click", (e) => {
  const d = (e.target as HTMLElement).closest("[data-del]") as HTMLElement;
  if (d) {
    e.preventDefault(); // don't follow the entry link
    deleteBattle(d.dataset.del!);
  }
});

/* ===================================================================== */
/*  INIT                                                                  */
/* ===================================================================== */
refreshKeyUI();
refreshViewTabs();
refreshScrollBtn();
refreshBlindUI();
syncRunBtn();
updateHistoryCount();
installMetricTooltips();
installTimelineTracking();
loadModels();
