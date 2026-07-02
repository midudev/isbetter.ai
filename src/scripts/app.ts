/* =========================================================================
   AI BATTLE — run one prompt across many OpenRouter models, compare results.
   All state (api key, prompt, selection) lives in the browser. No backend.
   ========================================================================= */
import {
  esc,
  svg,
  fmtInt,
  fmtDur,
  fmtCost,
  fmtRate,
  estTokens,
  extractCode,
  formatCode,
  highlightCode,
  statsRowHTML,
  thoughtsHTML,
  doneContentHTML,
  loadHistory,
  saveHistory,
  fmtWhen,
  installScrollSync,
  SCROLLLINK_KEY,
  type Battle,
  type HistoryResult,
} from "./lib";

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

type ViewMode = "output" | "code" | "preview";
type ProviderId = "openrouter" | "openai" | "anthropic" | "local";

interface ModelInfo {
  id: string;
  name: string;
  promptPrice: number; // USD per token
  completionPrice: number; // USD per token
  context: number;
}

/* ------------------------------- providers ------------------------------- */
// A parsed streaming delta, normalized across the three APIs.
interface Chunk {
  content: string;
  reasoning: string;
  usage: any;
}
function parseOpenAIChunk(json: any): Chunk {
  const d = json.choices?.[0]?.delta || {};
  let reasoning = "";
  if (typeof d.reasoning === "string") reasoning = d.reasoning;
  else if (Array.isArray(d.reasoning_details))
    reasoning = d.reasoning_details.map((x: any) => x?.text || x?.summary || "").join("");
  return { content: d.content || "", reasoning, usage: json.usage || null };
}
function parseAnthropicChunk(json: any): Chunk {
  let content = "",
    reasoning = "",
    usage: any = null;
  if (json.type === "content_block_delta") {
    if (json.delta?.type === "text_delta") content = json.delta.text || "";
    else if (json.delta?.type === "thinking_delta") reasoning = json.delta.thinking || "";
  } else if (json.type === "message_start") {
    const u = json.message?.usage;
    if (u) usage = { prompt_tokens: u.input_tokens };
  } else if (json.type === "message_delta") {
    if (json.usage) usage = { completion_tokens: json.usage.output_tokens };
  }
  return { content, reasoning, usage };
}

/* ---------------------------------------------------------------------------
   Built-in price table (USD per 1M tokens) for providers that don't return
   cost. OpenRouter carries its own pricing via its API. Matched by id prefix,
   most-specific first. Sourced from the official OpenAI/Anthropic pricing pages
   (July 2026) — see the summary shown to the user.
--------------------------------------------------------------------------- */
const OPENAI_PRICES: [string, number, number][] = [
  ["gpt-5.6-sol", 5, 30],
  ["gpt-5.6-terra", 2.5, 15],
  ["gpt-5.6-luna", 1, 6],
  ["gpt-5.6", 2.5, 15],
  ["gpt-5.5-pro", 30, 180],
  ["gpt-5.5", 5, 30],
  ["gpt-5.4-mini", 0.75, 4.5],
  ["gpt-5.4-nano", 0.2, 1.25],
  ["gpt-5.4-pro", 30, 180],
  ["gpt-5.4", 2.5, 15],
  ["gpt-5.3-codex", 1.75, 14],
  ["gpt-5-mini", 0.25, 2],
  ["gpt-5-nano", 0.05, 0.4],
  ["gpt-5", 1.25, 10],
  ["gpt-4.1-mini", 0.4, 1.6],
  ["gpt-4.1-nano", 0.1, 0.4],
  ["gpt-4.1", 2, 8],
  ["chatgpt-4o", 2.5, 10],
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["o4-mini", 1.1, 4.4],
  ["o3-mini", 1.1, 4.4],
  ["o3", 2, 8],
  ["o1", 15, 60],
  ["gpt-chat-latest", 5, 30],
  ["chatgpt", 5, 30],
];
const ANTHROPIC_PRICES: [string, number, number][] = [
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4-1", 15, 75],
  ["claude-opus-4", 15, 75],
  ["claude-opus", 5, 25],
  ["claude-sonnet-5", 3, 15],
  ["claude-sonnet-4-6", 3, 15],
  ["claude-sonnet-4-5", 3, 15],
  ["claude-sonnet-4", 3, 15],
  ["claude-sonnet", 3, 15],
  ["claude-haiku-4-5", 1, 5],
  ["claude-haiku-3-5", 0.8, 4],
  ["claude-haiku", 1, 5],
  ["claude-fable", 10, 50],
  ["claude-mythos", 10, 50],
];
// Returns per-TOKEN {prompt, completion} prices, or null if unknown.
function priceFor(provider: ProviderId, id: string): { prompt: number; completion: number } | null {
  const table = provider === "openai" ? OPENAI_PRICES : provider === "anthropic" ? ANTHROPIC_PRICES : null;
  if (!table) return null;
  const lid = id.toLowerCase();
  for (const [prefix, i, o] of table)
    if (lid.startsWith(prefix)) return { prompt: i / 1e6, completion: o / 1e6 };
  return null;
}

interface Provider {
  name: string;
  short: string;
  color: string;
  keyPlaceholder: string;
  keyUrl: string;
  modelsUrl: string;
  modelsNeedKey: boolean;
  chatUrl: string;
  headers: (key: string) => Record<string, string>;
  body: (model: string, system: string, user: string) => object;
  parse: (json: any) => Chunk;
  parseModels: (json: any) => ModelInfo[];
}

const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    name: "OpenRouter",
    short: "OR",
    color: "#d8ff3e",
    keyPlaceholder: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    modelsNeedKey: true,
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": location.origin,
      "X-Title": "AI Battle",
    }),
    body: (model, system, user) => ({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
      usage: { include: true },
      reasoning: { enabled: true },
    }),
    parse: parseOpenAIChunk,
    parseModels: (json) =>
      (json.data || []).map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        promptPrice: parseFloat(m.pricing?.prompt || "0"),
        completionPrice: parseFloat(m.pricing?.completion || "0"),
        context: m.context_length || 0,
      })),
  },
  openai: {
    name: "OpenAI",
    short: "OpenAI",
    color: "#10a37f",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    modelsUrl: "https://api.openai.com/v1/models",
    modelsNeedKey: true,
    chatUrl: "https://api.openai.com/v1/chat/completions",
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    }),
    body: (model, system, user) => ({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
      stream_options: { include_usage: true },
    }),
    parse: parseOpenAIChunk,
    parseModels: (json) =>
      (json.data || [])
        .filter(
          (m: any) =>
            /gpt|^o\d|^chatgpt/i.test(m.id) &&
            !/embedding|tts|whisper|audio|image|dall|realtime|moderation|transcribe|search/i.test(
              m.id,
            ),
        )
        .map((m: any) => {
          const p = priceFor("openai", m.id);
          return {
            id: m.id,
            name: m.id,
            promptPrice: p?.prompt || 0,
            completionPrice: p?.completion || 0,
            context: 0,
          };
        }),
  },
  anthropic: {
    name: "Anthropic",
    short: "Claude",
    color: "#d97757",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    modelsUrl: "https://api.anthropic.com/v1/models",
    modelsNeedKey: true,
    chatUrl: "https://api.anthropic.com/v1/messages",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json",
    }),
    body: (model, system, user) => ({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: user }],
      stream: true,
    }),
    parse: parseAnthropicChunk,
    parseModels: (json) =>
      (json.data || []).map((m: any) => {
        const p = priceFor("anthropic", m.id);
        return {
          id: m.id,
          name: m.display_name || m.id,
          promptPrice: p?.prompt || 0,
          completionPrice: p?.completion || 0,
          context: 0,
        };
      }),
  },
  // A self-hosted, OpenAI-compatible server (Ollama, LM Studio, llama.cpp,
  // vLLM, LocalAI…). The "credential" is the base URL — stored in the key slot
  // — and its `/models` endpoint is listed automatically. No auth, no cost.
  local: {
    name: "Local",
    short: "Local",
    color: "#8b93a7",
    keyPlaceholder: "http://localhost:11434/v1",
    keyUrl: "",
    modelsUrl: "", // resolved from the base URL at call time (see modelsUrlFor)
    modelsNeedKey: true, // gated on the base URL rather than an API key
    chatUrl: "", // resolved from the base URL at call time (see chatUrlFor)
    headers: () => ({ "Content-Type": "application/json" }),
    body: (model, system, user) => ({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
      stream_options: { include_usage: true },
    }),
    parse: parseOpenAIChunk,
    parseModels: (json) =>
      (json.data || json.models || []).map((m: any) => ({
        id: m.id || m.name,
        name: m.name || m.id,
        promptPrice: 0,
        completionPrice: 0,
        context: m.context_length || 0,
      })),
  },
};
const PROVIDER_IDS: ProviderId[] = ["openrouter", "openai", "anthropic", "local"];

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
const BRAND_KEYWORDS = ["claude", "openai/gpt", "gemini", "deepseek", "grok", "llama"];
const SKIP_VARIANT = /image|audio|tts|embed|video|vision|moderation|guard|free/i;

const LS = {
  models: "ab:models",
  system: "ab:system",
  prompt: "ab:prompt",
  view: "ab:view",
  scrollLink: SCROLLLINK_KEY,
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
  codeFmt: string; // pretty-printed (used for copy)
  codeHtml: string; // highlighted HTML markup (used for the code view)
  error: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number; // total time: request → finish
  genMs: number; // generation time: first token → finish
  firstTokenAt?: number; // performance.now() when the first token arrived
  view?: ViewMode; // per-card view override (auto-set to preview on finish)
  prompt: string; // user prompt this result was generated for (for caching)
  system: string; // system prompt this result was generated for
  el: HTMLElement;
  timer?: number;
  startedAt: number;
}

/* ------------------------------- tiny utils ------------------------------ */
const $ = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

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
const keys: Record<ProviderId, string> = {
  openrouter: localStorage.getItem(keyLS("openrouter")) || "",
  openai: localStorage.getItem(keyLS("openai")) || "",
  anthropic: localStorage.getItem(keyLS("anthropic")) || "",
  local: localStorage.getItem(keyLS("local")) || "",
};
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
let systemPrompt = localStorage.getItem(LS.system) || DEFAULT_SYSTEM_PROMPT;
let selected: string[] = JSON.parse(localStorage.getItem(LS.models) || "[]"); // composite keys
const providerModels: Record<ProviderId, ModelInfo[]> = {
  openrouter: [],
  openai: [],
  anthropic: [],
  local: [],
};
const catalog = new Map<string, ModelInfo>(); // composite key → model info
const loadedProviders = new Set<ProviderId>();
let dropdownProvider: ProviderId = "openrouter";
const entries = new Map<string, Entry>(); // keyed by composite key
let running = false;

/* --------------------------------- refs ---------------------------------- */
const els = {
  keyBtn: $("#key-btn"),
  keyDot: $("#key-dot"),
  keyModal: $("#key-modal"),
  keyBackdrop: $("#key-backdrop"),
  keySave: $("#key-save"),
  keyCancel: $("#key-cancel"),
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
  runBtn: $<HTMLButtonElement>("#run-btn"),
  rerunAllBtn: $<HTMLButtonElement>("#rerun-all-btn"),
  runLabel: $("#run-label"),
  runIcon: $("#run-icon"),
  viewControls: $("#view-controls"),
  scrollBtn: $("#scroll-link-btn"),
  results: $("#results"),
  empty: $("#empty-state"),
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
function refreshKeyUI() {
  const has = anyKey();
  els.keyDot.style.background = has ? "var(--color-ink-faint)" : "var(--color-accent)";
  els.keyDot.classList.toggle("animate-pulse", !has);
}
function openKeyModal() {
  for (const p of PROVIDER_IDS) {
    const inp = document.querySelector<HTMLInputElement>(`#api-key-${p}`);
    if (inp) inp.value = keyFor(p);
  }
  els.keyModal.classList.remove("hidden");
  setTimeout(() => document.querySelector<HTMLInputElement>("#api-key-openrouter")?.focus(), 30);
}
function closeKeyModal() {
  els.keyModal.classList.add("hidden");
}
els.keyBtn.addEventListener("click", openKeyModal);
els.keyCancel.addEventListener("click", closeKeyModal);
els.keyBackdrop.addEventListener("click", closeKeyModal);
els.keySave.addEventListener("click", () => {
  for (const p of PROVIDER_IDS) {
    const inp = document.querySelector<HTMLInputElement>(`#api-key-${p}`);
    const val = inp?.value.trim() || "";
    const changed = val !== keys[p];
    keys[p] = val;
    if (val) localStorage.setItem(keyLS(p), val);
    else localStorage.removeItem(keyLS(p));
    // A provider that just got a key can now load its models.
    if (changed && val && PROVIDERS[p].modelsNeedKey) loadProviderModels(p);
  }
  refreshKeyUI();
  syncRunBtn();
  closeKeyModal();
});
PROVIDER_IDS.forEach((p) => {
  document.querySelector(`#api-key-${p}`)?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") els.keySave.dispatchEvent(new Event("click"));
  });
});

/* ===================================================================== */
/*  MODELS — per-provider catalogs, provider-tabbed picker, chips        */
/* ===================================================================== */
async function loadProviderModels(p: ProviderId) {
  const prov = PROVIDERS[p];
  if (prov.modelsNeedKey && !hasCreds(p)) {
    providerModels[p] = [];
    if (dropdownProvider === p) renderModelList();
    return;
  }
  try {
    const res = await fetch(
      modelsUrlFor(p),
      prov.modelsNeedKey ? { headers: prov.headers(keyFor(p)) } : {},
    );
    const json = await res.json();
    providerModels[p] = prov.parseModels(json).sort((a, b) => a.id.localeCompare(b.id));
    loadedProviders.add(p);
    for (const m of providerModels[p]) catalog.set(provKey(p, m.id), m);
  } catch {
    providerModels[p] = [];
  }
  renderChips(); // names may have resolved
  if (dropdownProvider === p) renderModelList();
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

const contenderName = (key: string) =>
  (catalog.get(key)?.name || parseKey(key).id).replace(/\s*\(.*?\)\s*$/, "");

// Cost estimate: catalog pricing when known (OpenRouter/known models), else the
// built-in price table (covers custom-typed OpenAI/Anthropic ids).
function costFor(entry: Entry, promptTokens: number, completionTokens: number): number {
  const cat = catalog.get(entry.key);
  if (cat && (cat.promptPrice || cat.completionPrice))
    return promptTokens * cat.promptPrice + completionTokens * cat.completionPrice;
  const pr = priceFor(entry.provider, entry.id);
  return pr ? promptTokens * pr.prompt + completionTokens * pr.completion : 0;
}

function providerBadge(p: ProviderId) {
  const prov = PROVIDERS[p];
  return `<span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide" style="color:${prov.color};background:${prov.color}1a" title="${prov.name}">${esc(prov.short)}</span>`;
}

function priceLabel(m: ModelInfo) {
  if (!m.promptPrice && !m.completionPrice) return "";
  const i = (m.promptPrice * 1e6).toFixed(2);
  const o = (m.completionPrice * 1e6).toFixed(2);
  return `$${i}/M in · $${o}/M out`;
}

function renderChips() {
  els.count.textContent = String(selected.length);
  [...els.chips.querySelectorAll(".model-chip")].forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  for (const key of selected) {
    const { provider } = parseKey(key);
    const chip = document.createElement("div");
    chip.className =
      "model-chip group flex items-center gap-1.5 rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] py-1.5 pl-2 pr-1.5 text-[12px] text-[var(--color-ink)]";
    chip.innerHTML = `
      ${providerBadge(provider)}
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
  });

  const p = dropdownProvider;
  const prov = PROVIDERS[p];
  const models = providerModels[p];
  const q = els.search.value.trim().toLowerCase();
  const qraw = els.search.value.trim();
  const matches = (q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : models
  ).slice(0, 80);

  let html = "";
  if (prov.modelsNeedKey && !hasCreds(p)) {
    const what = p === "local" ? "base URL" : "API key";
    const cta = p === "local" ? "set base URL" : "add key";
    html += `<li class="px-3 py-6 text-center text-[11px] leading-relaxed text-[var(--color-ink-faint)]">Set your ${esc(prov.name)} ${what} to list its models.<br/><button data-openkeys class="mt-2 text-[var(--color-accent)] underline-offset-2 hover:underline">${cta}</button></li>`;
  } else if (!models.length) {
    html += `<li class="px-3 py-6 text-center text-[var(--color-ink-faint)]">${loadedProviders.has(p) ? "no models" : "loading models…"}</li>`;
  }
  for (const m of matches) {
    const key = provKey(p, m.id);
    const on = selected.includes(key);
    const price = priceLabel(m);
    html += `
      <li>
        <button data-add="${esc(key)}" class="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--color-panel-hi)]">
          <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${on ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-black" : "border-[var(--color-line-hi)] text-transparent"}">
            ${svg("i-check", "size-3")}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[var(--color-ink)]">${esc(m.name)}</span>
            <span class="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-ink-faint)]">${esc(m.id)}${price ? " · " + price : ""}</span>
          </span>
        </button>
      </li>`;
  }
  if (qraw && !models.some((m) => m.id.toLowerCase() === q)) {
    html += `
      <li>
        <button data-add="${esc(provKey(p, qraw))}" class="flex w-full items-center gap-2.5 border-t border-[var(--color-line)] px-3 py-2.5 text-left text-[var(--color-accent)] transition-colors hover:bg-[var(--color-panel-hi)]">
          ${svg("i-plus", "size-4")}
          <span>add ${esc(prov.short)}: <span class="font-mono">${esc(qraw)}</span></span>
        </button>
      </li>`;
  }
  if (!matches.length && models.length && !qraw) {
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
  else selected.push(key);
  persistSelection();
  renderChips();
  renderModelList();
});

// provider tabs inside the dropdown
els.dropdown.addEventListener("click", (e) => {
  const tab = (e.target as HTMLElement).closest("[data-provtab]") as HTMLElement;
  if (!tab) return;
  dropdownProvider = tab.dataset.provtab as ProviderId;
  els.search.value = "";
  if (!loadedProviders.has(dropdownProvider)) loadProviderModels(dropdownProvider);
  renderModelList();
});

function toggleDropdown(open?: boolean) {
  const show = open ?? els.dropdown.classList.contains("hidden");
  els.dropdown.classList.toggle("hidden", !show);
  if (show) {
    els.search.value = "";
    if (!loadedProviders.has(dropdownProvider)) loadProviderModels(dropdownProvider);
    renderModelList();
    setTimeout(() => els.search.focus(), 20);
  }
}
els.addBtn.addEventListener("click", () => toggleDropdown());
els.search.addEventListener("input", renderModelList);
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && els.search.value.trim()) {
    const key = provKey(dropdownProvider, els.search.value.trim());
    if (!selected.includes(key)) selected.push(key);
    persistSelection();
    renderChips();
    renderModelList();
  }
});
document.addEventListener("click", (e) => {
  if (!els.addWrap.contains(e.target as Node)) toggleDropdown(false);
});

/* ===================================================================== */
/*  SYSTEM PROMPT                                                         */
/* ===================================================================== */
els.sysText.value = systemPrompt;
els.sysToggle.addEventListener("click", () => {
  const open = els.sysPanel.classList.toggle("hidden");
  els.sysChevron.style.transform = open ? "" : "rotate(-90deg)";
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
    tab.classList.toggle("text-[var(--color-ink)]", on);
    tab.classList.toggle("text-[var(--color-ink-dim)]", !on);
    tab.setAttribute("aria-selected", String(on));
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

/* ----- scroll link: scroll every result pane together ------------------- */
function refreshScrollBtn() {
  els.scrollBtn.classList.toggle("border-[var(--color-accent)]", scrollLink);
  els.scrollBtn.classList.toggle("text-[var(--color-accent)]", scrollLink);
  els.scrollBtn.classList.toggle("text-[var(--color-ink-dim)]", !scrollLink);
  els.scrollBtn.setAttribute("aria-pressed", String(scrollLink));
}
function toggleScrollLink() {
  scrollLink = !scrollLink;
  localStorage.setItem(LS.scrollLink, scrollLink ? "1" : "0");
  refreshScrollBtn();
}
els.scrollBtn.addEventListener("click", toggleScrollLink);
installScrollSync(() => scrollLink);

/* ===================================================================== */
/*  PROMPT + RUN button enablement                                       */
/* ===================================================================== */
els.prompt.value = localStorage.getItem(LS.prompt) || "";
els.prompt.addEventListener("input", () => {
  localStorage.setItem(LS.prompt, els.prompt.value);
  syncRunBtn();
});
function syncRunBtn() {
  // Keep Run clickable so a first-time visitor can press it and be guided to
  // add their key / write a prompt (see runBattle). Only block it mid-run.
  els.runBtn.disabled = running;
  els.rerunAllBtn.disabled = running;
  // "Re-run all" only matters once there are results to refresh.
  els.rerunAllBtn.classList.toggle("hidden", entries.size === 0);
}
els.runBtn.addEventListener("click", () => runBattle());
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
    return runBattle();
  }
  // Single-letter shortcuts: skip while typing or when a modifier is held.
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const map: Record<string, () => void> = {
    o: () => setView("output"),
    c: () => setView("code"),
    p: () => setView("preview"),
    r: () => runBattle(),
    k: () => openKeyModal(),
    m: () => toggleDropdown(),
    s: () => els.sysToggle.click(),
    h: () => toggleHistory(),
    l: () => toggleScrollLink(),
    "/": () => els.prompt.focus(),
  };
  const fn = map[e.key.toLowerCase()];
  if (fn) {
    e.preventDefault();
    fn();
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
      { durationMs: total, genMs: gen, promptTokens: entry.promptTokens, completionTokens: out, cost },
      { live: true },
    );
  }
  return statsRowHTML(
    {
      durationMs: entry.durationMs,
      genMs: entry.genMs,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      cost: entry.cost,
    },
    { best },
  );
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
  return doneContentHTML(entry, viewOf(entry));
}

function renderContent(entry: Entry) {
  const slot = entry.el.querySelector("[data-content]") as HTMLElement;
  if (slot) slot.innerHTML = contentHTML(entry);
}

function renderCard(entry: Entry, best: Record<string, boolean> = {}) {
  const hasCode = entry.state === "done" && !!entry.code;
  entry.el.innerHTML = `
    <div class="flex items-center gap-2 px-3 py-2.5">
      <span class="size-2 shrink-0 rounded-full ${dotColor(entry.state)}"></span>
      ${providerBadge(entry.provider)}
      <span class="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink)]" title="${esc(entry.key)}">${esc(contenderName(entry.key))}</span>
      ${
        hasCode
          ? `<button data-action="open" data-model="${esc(entry.key)}" class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]" title="open preview in new tab">${svg("i-expand", "size-4")}</button>`
          : ""
      }
      <button data-action="rerun" data-model="${esc(entry.key)}" class="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)] ${entry.state === "loading" ? "pointer-events-none opacity-40" : ""}" title="re-run this model">${svg("i-refresh", "size-4")}</button>
    </div>
    <div data-stats>${statsRow(entry, best)}</div>
    <div data-content class="h-[clamp(22rem,52vh,42rem)] border-t border-[var(--color-line)] bg-[var(--color-surface)]"></div>`;
  renderContent(entry);
}

/* ===================================================================== */
/*  RUN                                                                   */
/* ===================================================================== */
function newCard(key: string): Entry {
  const { provider, id } = parseKey(key);
  const el = document.createElement("article");
  el.className =
    "result-card flex flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]";
  el.dataset.card = key;
  const entry: Entry = {
    id,
    provider,
    key,
    state: "loading",
    raw: "",
    reasoning: "",
    code: "",
    codeFmt: "",
    codeHtml: "",
    error: "",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    durationMs: 0,
    genMs: 0,
    prompt: "",
    system: "",
    el,
    startedAt: performance.now(),
  };
  return entry;
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
  const stats = entry.el.querySelector("[data-stats]");
  if (stats) stats.innerHTML = statsRow(entry);
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
  entry.code = entry.codeFmt = entry.codeHtml = entry.error = "";
  entry.firstTokenAt = undefined;
  entry.genMs = 0;
  entry.view = undefined;
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
  try {
    const res = await fetch(chatUrlFor(entry.provider), {
      method: "POST",
      headers: prov.headers(key),
      body: JSON.stringify(prov.body(entry.id, usedSystem, usedPrompt)),
    });

    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const j = await res.json();
        msg = j.error?.message || j.error || msg;
      } catch {}
      throw new Error(msg);
    }

    // Streaming has begun — flip to the live view.
    entry.state = "streaming";
    entry.promptTokens = estTokens(usedSystem + usedPrompt);
    renderCard(entry);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: any = null;
    let streamError: string | null = null;

    stream: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(":")) continue; // keep-alive / comments
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") break stream;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error || json.type === "error") {
          streamError = json.error?.message || json.error || "stream error";
          break stream;
        }
        // Reasoning (chain-of-thought) arrives before the answer.
        const parsed = prov.parse(json);
        if (parsed.reasoning) {
          if (entry.firstTokenAt == null) entry.firstTokenAt = performance.now();
          entry.reasoning += parsed.reasoning;
        }
        if (parsed.content) {
          if (entry.firstTokenAt == null) entry.firstTokenAt = performance.now();
          entry.raw += parsed.content;
        }
        if (parsed.usage) usage = { ...usage, ...parsed.usage };
      }
    }

    const end = performance.now();
    entry.durationMs = end - entry.startedAt;
    entry.genMs = entry.firstTokenAt != null ? end - entry.firstTokenAt : entry.durationMs;
    if (streamError && !entry.raw) throw new Error(streamError);

    entry.code = extractCode(entry.raw);
    if (entry.code) {
      entry.codeFmt = formatCode(entry.code);
      entry.codeHtml = highlightCode(entry.codeFmt);
    }
    entry.completionTokens = usage?.completion_tokens || estTokens(entry.raw);
    entry.promptTokens = usage?.prompt_tokens || entry.promptTokens;
    entry.totalTokens =
      usage?.total_tokens || entry.promptTokens + entry.completionTokens;
    entry.cost =
      typeof usage?.cost === "number"
        ? usage.cost
        : costFor(entry, entry.promptTokens, entry.completionTokens);

    entry.state = entry.raw ? "done" : "error";
    if (!entry.raw) entry.error = streamError || "Model returned an empty response.";
    // When a block finishes while you're on the Output view, flip just that
    // block to Preview so its solution is shown.
    if (entry.state === "done" && entry.code && viewMode === "output")
      entry.view = "preview";
  } catch (err: any) {
    entry.durationMs = performance.now() - entry.startedAt;
    entry.genMs = entry.firstTokenAt != null ? performance.now() - entry.firstTokenAt : entry.durationMs;
    entry.state = "error";
    entry.error = err?.message || "Request failed.";
  } finally {
    stopTimer(entry);
    renderCard(entry);
  }
}

function computeBests() {
  const done = [...entries.values()].filter((e) => e.state === "done");
  if (done.length < 2) return;
  const rate = (e: Entry) => e.completionTokens / (e.genMs || e.durationMs || 1);
  const best = {
    fast: done.reduce((a, b) => (b.durationMs < a.durationMs ? b : a)),
    cheap: done.reduce((a, b) => (b.cost < a.cost ? b : a)),
    tput: done.reduce((a, b) => (rate(b) > rate(a) ? b : a)),
  };
  for (const e of done) {
    renderCard(e, {
      fast: e === best.fast,
      cheap: e === best.cheap && e.cost > 0,
      tput: e === best.tput,
    });
  }
}

// force = true re-runs every selected model (ignores the cache). Otherwise we
// reuse any result already computed for this exact prompt + system prompt and
// only call the models that are new, stale, or errored — saving tokens.
async function runBattle(force = false) {
  if (running) return;
  // Guide the user instead of silently doing nothing.
  if (!selected.length) return toggleDropdown(true);
  const neededProviders = [...new Set(selected.map((k) => parseKey(k).provider))];
  if (!neededProviders.some((p) => keyFor(p).trim())) return openKeyModal();
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    els.prompt.focus();
    return;
  }

  els.empty.classList.add("hidden");

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
  for (const id of selected) {
    const cur = entries.get(id);
    const canReuse =
      !force &&
      cur &&
      cur.state === "done" &&
      cur.prompt === prompt &&
      cur.system === systemPrompt;
    if (canReuse) {
      els.results.appendChild(cur!.el); // reorder to selection order
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

  if (!toRun.length) {
    computeBests(); // everything was cached — no API calls made
    return;
  }

  running = true;
  syncRunBtn();
  if (!reused) setView("output"); // full run: jump to Output to watch streaming
  els.runLabel.textContent = "Running…";
  els.runIcon.innerHTML = `<use href="#i-refresh"></use>`;
  els.runIcon.classList.add("spin");

  await Promise.allSettled(toRun.map((e) => callModel(e)));

  // Keep the finished blocks consistent — show every solution as a preview.
  if (viewMode === "output")
    for (const e of entries.values())
      if (e.state === "done" && e.code && e.view !== "preview") {
        e.view = "preview";
        renderCard(e);
      }

  computeBests();
  saveBattle();

  running = false;
  els.runLabel.textContent = "Run battle";
  els.runIcon.innerHTML = `<use href="#i-play"></use>`;
  els.runIcon.classList.remove("spin");
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
    await navigator.clipboard.writeText(entry.codeFmt || entry.code);
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
  } else if (action === "rerun") {
    if (!keyFor(entry.provider).trim()) return openKeyModal();
    await callModel(entry);
    computeBests();
  } else if (action === "open" && entry.code) {
    const blob = new Blob([entry.code], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  }
});

/* ===================================================================== */
/*  HISTORY — every battle is archived to localStorage; entries link to    */
/*  the /battle detail route for review.                                  */
/* ===================================================================== */
let history: Battle[] = loadHistory();
let battleSeq = 0;
const battleId = (b: Battle) => b.id || String(b.ts);

function persistHistory() {
  history = saveHistory(history);
  updateHistoryCount();
}

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
      durationMs: e.durationMs,
      genMs: e.genMs,
    }));
  if (!results.length) return;
  const ts = Date.now();
  history.unshift({
    id: `${ts}-${(battleSeq++).toString(36)}`,
    ts,
    prompt: els.prompt.value.trim(),
    system: systemPrompt,
    results,
  });
  persistHistory();
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
      const cheapest = ok.length
        ? ok.reduce((a, c) => (c.cost < a.cost ? c : a))
        : null;
      const lbl = (r: HistoryResult) => esc(r.label || r.id);
      const chips = b.results
        .map(
          (r) => `
        <span class="inline-flex items-center gap-1 rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] ${r.state === "error" ? "text-red-400/80" : "text-[var(--color-ink-dim)]"}">
          ${r.provider ? providerBadge(r.provider) : `<span class="size-1 rounded-full ${r.state === "error" ? "bg-red-500" : "bg-emerald-400"}"></span>`}${lbl(r)}
        </span>`,
        )
        .join("");
      return `
      <a href="/battle?id=${encodeURIComponent(id)}" class="group mb-2 block rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-line-hi)]">
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
            <svg class="size-3"><use href="#i-clock"></use></svg>${fmtWhen(b.ts)}
          </span>
          <div class="flex items-center gap-1">
            <span class="flex items-center gap-1 rounded-md border border-[var(--color-line)] px-2 py-1 text-[10px] text-[var(--color-ink-dim)] transition-colors group-hover:border-[var(--color-accent)] group-hover:text-[var(--color-ink)]">
              <svg class="size-3.5"><use href="#i-restore"></use></svg>open
            </span>
            <button data-del="${esc(id)}" class="grid size-6 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-red-400" title="delete">
              <svg class="size-3.5"><use href="#i-trash"></use></svg>
            </button>
          </div>
        </div>
        <p class="mt-2 line-clamp-2 text-[12px] text-[var(--color-ink)]">${b.prompt ? esc(b.prompt) : '<span class="text-[var(--color-ink-faint)]">(empty prompt)</span>'}</p>
        <div class="mt-2 flex flex-wrap gap-1">${chips}</div>
        ${
          ok.length
            ? `<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-ink-faint)]">
                <span class="inline-flex items-center gap-1"><svg class="size-3"><use href="#i-clock"></use></svg>${fmtDur(fastest!.durationMs)} · ${lbl(fastest!)}</span>
                <span class="inline-flex items-center gap-1"><svg class="size-3"><use href="#i-coin"></use></svg>${fmtCost(cheapest!.cost)} · ${lbl(cheapest!)}</span>
              </div>`
            : ""
        }
      </a>`;
    })
    .join("");
}

function deleteBattle(id: string) {
  history = history.filter((b) => battleId(b) !== id);
  persistHistory();
  renderHistory();
}
function clearHistory() {
  history = [];
  persistHistory();
  renderHistory();
}
function openHistory() {
  renderHistory();
  els.historyDrawer.classList.remove("hidden");
  requestAnimationFrame(() => els.historyPanel.classList.remove("translate-x-full"));
}
function closeHistory() {
  els.historyPanel.classList.add("translate-x-full");
  setTimeout(() => els.historyDrawer.classList.add("hidden"), 300);
}
function toggleHistory() {
  if (els.historyDrawer.classList.contains("hidden")) openHistory();
  else closeHistory();
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
syncRunBtn();
updateHistoryCount();
loadModels();
