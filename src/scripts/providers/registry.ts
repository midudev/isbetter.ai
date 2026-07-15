import type { Chunk, ModelInfo, Provider, ProviderId, UsageInfo } from "./types";
import openAILogo from "@lobehub/icons-static-svg/icons/openai.svg?url";
import anthropicLogo from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import xAILogo from "@lobehub/icons-static-svg/icons/xai.svg?url";
import deepSeekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral-color.svg?url";
import groqLogo from "@lobehub/icons-static-svg/icons/groq.svg?url";
import cerebrasLogo from "@lobehub/icons-static-svg/icons/cerebras-color.svg?url";

const OPENROUTER_LOGO = `data:image/svg+xml,${encodeURIComponent(
  `<svg width="28.3" height="20" viewBox="19.82 17.199 365.556 258.298" xmlns="http://www.w3.org/2000/svg" fill="currentColor" role="img" aria-label="OpenRouter"><path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z"></path></svg>`,
)}`;

const LOCAL_LOGO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='13' rx='2'/%3E%3Cpath d='m8 9 2 2-2 2m4 0h4M8 21h8m-4-4v4'/%3E%3C/svg%3E";

type JsonObject = Record<string, any>;
type PriceRow = readonly [prefix: string, inputPerMillion: number, outputPerMillion: number];

const asObject = (value: unknown): JsonObject =>
  value && typeof value === "object" ? (value as JsonObject) : {};

const textFrom = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = asObject(part);
      return typeof item.text === "string" ? item.text : "";
    })
    .join("");
};

export function parseOpenAIChunk(value: unknown): Chunk {
  const json = asObject(value);
  const choice = asObject(json.choices?.[0]);
  const delta = asObject(choice.delta);
  const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
  const reasoning =
    textFrom(delta.reasoning_content) ||
    textFrom(delta.reasoning) ||
    details.map((item: unknown) => textFrom(asObject(item).text || asObject(item).summary)).join("");
  return {
    content: textFrom(delta.content),
    reasoning,
    usage: json.usage ? (json.usage as UsageInfo) : null,
    ...(typeof choice.finish_reason === "string"
      ? { finishReason: choice.finish_reason }
      : {}),
  };
}

export function parseAnthropicChunk(value: unknown): Chunk {
  const json = asObject(value);
  let content = "";
  let reasoning = "";
  let usage: UsageInfo | null = null;
  let finishReason: string | undefined;
  if (json.type === "content_block_delta") {
    const delta = asObject(json.delta);
    if (delta.type === "text_delta") content = textFrom(delta.text);
    if (delta.type === "thinking_delta" || delta.type === "signature_delta")
      reasoning = textFrom(delta.thinking);
  } else if (json.type === "message_start") {
    const input = asObject(json.message).usage?.input_tokens;
    if (typeof input === "number") usage = { prompt_tokens: input };
  } else if (json.type === "message_delta") {
    const delta = asObject(json.delta);
    const output = asObject(json.usage).output_tokens;
    if (typeof output === "number") usage = { completion_tokens: output };
    if (typeof delta.stop_reason === "string") finishReason = delta.stop_reason;
  }
  return { content, reasoning, usage, ...(finishReason ? { finishReason } : {}) };
}

const OPENAI_PRICES: PriceRow[] = [
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
  ["gpt-5-mini", 0.25, 2],
  ["gpt-5-nano", 0.05, 0.4],
  ["gpt-5", 1.25, 10],
  ["gpt-4.1-mini", 0.4, 1.6],
  ["gpt-4.1-nano", 0.1, 0.4],
  ["gpt-4.1", 2, 8],
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["o4-mini", 1.1, 4.4],
  ["o3-mini", 1.1, 4.4],
  ["o3", 2, 8],
  ["o1", 15, 60],
];

const ANTHROPIC_PRICES: PriceRow[] = [
  ["claude-fable-5", 10, 50],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4-1", 15, 75],
  ["claude-opus-4", 15, 75],
  ["claude-sonnet-5", 3, 15],
  ["claude-sonnet-4-6", 3, 15],
  ["claude-sonnet-4-5", 3, 15],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4-5", 1, 5],
  ["claude-haiku-3-5", 0.8, 4],
];

const DEEPSEEK_PRICES: PriceRow[] = [
  ["deepseek-v4-flash", 0.14, 0.28],
  ["deepseek-v4-pro", 0.435, 0.87],
];

const PRICE_TABLES: Partial<Record<ProviderId, PriceRow[]>> = {
  openai: OPENAI_PRICES,
  anthropic: ANTHROPIC_PRICES,
  deepseek: DEEPSEEK_PRICES,
};

export function priceFor(
  provider: ProviderId,
  modelId: string,
): { prompt: number; completion: number } | null {
  if (provider === "local") return { prompt: 0, completion: 0 };
  const rows = PRICE_TABLES[provider];
  if (!rows) return null;
  const id = modelId.toLowerCase();
  for (const [prefix, input, output] of rows)
    if (id.startsWith(prefix)) return { prompt: input / 1e6, completion: output / 1e6 };
  return null;
}

function genericModels(value: unknown, provider?: ProviderId): ModelInfo[] {
  const json = asObject(value);
  const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return rows
    .map((raw: unknown) => {
      const model = asObject(raw);
      const id = String(model.id || model.name || "");
      if (!id) return null;
      const price = provider ? priceFor(provider, id) : null;
      return {
        id,
        name: String(model.display_name || model.name || id),
        promptPrice: price?.prompt ?? null,
        completionPrice: price?.completion ?? null,
        context: Number(model.context_length || model.context_window || 0),
      };
    })
    .filter((model: ModelInfo | null): model is ModelInfo => model !== null)
    .filter(
      (model) =>
        !/embedding|embed|rerank|tts|audio|image|video|moderation|whisper|transcrib/i.test(
          model.id,
        ),
    );
}

function openRouterModels(value: unknown): ModelInfo[] {
  const json = asObject(value);
  return (Array.isArray(json.data) ? json.data : []).map((raw: unknown) => {
    const model = asObject(raw);
    const prompt = Number.parseFloat(String(model.pricing?.prompt ?? ""));
    const completion = Number.parseFloat(String(model.pricing?.completion ?? ""));
    return {
      id: String(model.id),
      name: String(model.name || model.id),
      promptPrice: Number.isFinite(prompt) ? prompt : null,
      completionPrice: Number.isFinite(completion) ? completion : null,
      context: Number(model.context_length || 0),
    };
  });
}

function openAIModels(value: unknown): ModelInfo[] {
  return genericModels(value, "openai").filter(
    (model) =>
      /gpt|^o\d|^chatgpt/i.test(model.id) &&
      !/embedding|tts|whisper|audio|image|dall|realtime|moderation|transcribe|search/i.test(
        model.id,
      ),
  );
}

const bearerHeaders = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

const openAIBody = (includeUsage = false) => (model: string, system: string, user: string) => ({
  model,
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
  stream: true,
  ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
});

function compatibleProvider(
  config: Omit<Provider, "headers" | "body" | "parse" | "parseModels"> & {
    includeUsage?: boolean;
    parseModels?: Provider["parseModels"];
  },
): Provider {
  return {
    ...config,
    headers: bearerHeaders,
    body: openAIBody(config.includeUsage),
    parse: parseOpenAIChunk,
    parseModels: config.parseModels || ((json) => genericModels(json, config.id)),
  };
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    short: "OR",
    color: "#d8ff3e",
    logo: OPENROUTER_LOGO,
    logoMonochrome: true,
    keyPlaceholder: "sk-or-v1-…",
    keyUrl: "https://openrouter.ai/keys",
    credentialLabel: "API key",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    browserSupport: "supported",
    headers: (key) => ({
      ...bearerHeaders(key),
      "HTTP-Referer": location.origin,
      "X-Title": "AI Battle",
    }),
    body: (model, system, user) => ({
      ...openAIBody(false)(model, system, user),
      usage: { include: true },
      reasoning: { enabled: true },
    }),
    parse: parseOpenAIChunk,
    parseModels: openRouterModels,
  },
  openai: compatibleProvider({
    id: "openai",
    name: "OpenAI",
    short: "OpenAI",
    color: "#10a37f",
    logo: openAILogo,
    logoMonochrome: true,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    credentialLabel: "API key",
    modelsUrl: "https://api.openai.com/v1/models",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    browserSupport: "variable",
    includeUsage: true,
    parseModels: openAIModels,
  }),
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    short: "Claude",
    color: "#d97757",
    logo: anthropicLogo,
    logoMonochrome: true,
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    credentialLabel: "API key",
    modelsUrl: "https://api.anthropic.com/v1/models",
    chatUrl: "https://api.anthropic.com/v1/messages",
    browserSupport: "supported",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json",
    }),
    body: (model, system, user) => ({
      model,
      max_tokens: model.toLowerCase().startsWith("claude-fable-5") ? 16384 : 8192,
      system,
      messages: [{ role: "user", content: user }],
      stream: true,
    }),
    parse: parseAnthropicChunk,
    parseModels: (json) => genericModels(json, "anthropic"),
  },
  google: compatibleProvider({
    id: "google",
    name: "Google Gemini",
    short: "Gemini",
    color: "#4285f4",
    logo: geminiLogo,
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    credentialLabel: "API key",
    credentialHelp: "Use a Gemini API auth key restricted to the Gemini API.",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    browserSupport: "variable",
  }),
  xai: compatibleProvider({
    id: "xai",
    name: "xAI",
    short: "Grok",
    color: "#f2f2f2",
    logo: xAILogo,
    logoMonochrome: true,
    keyPlaceholder: "xai-…",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    credentialLabel: "API key",
    credentialHelp: "Uses xAI Chat Completions compatibility.",
    modelsUrl: "https://api.x.ai/v1/models",
    chatUrl: "https://api.x.ai/v1/chat/completions",
    browserSupport: "variable",
  }),
  deepseek: compatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    short: "DeepSeek",
    color: "#4d6bfe",
    logo: deepSeekLogo,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.deepseek.com/api_keys",
    credentialLabel: "API key",
    modelsUrl: "https://api.deepseek.com/models",
    chatUrl: "https://api.deepseek.com/chat/completions",
    browserSupport: "variable",
  }),
  mistral: compatibleProvider({
    id: "mistral",
    name: "Mistral AI",
    short: "Mistral",
    color: "#ff7000",
    logo: mistralLogo,
    keyPlaceholder: "…",
    keyUrl: "https://console.mistral.ai/api-keys",
    credentialLabel: "API key",
    modelsUrl: "https://api.mistral.ai/v1/models",
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
    browserSupport: "variable",
  }),
  groq: compatibleProvider({
    id: "groq",
    name: "Groq",
    short: "Groq",
    color: "#f55036",
    logo: groqLogo,
    logoMonochrome: true,
    keyPlaceholder: "gsk_…",
    keyUrl: "https://console.groq.com/keys",
    credentialLabel: "API key",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
    browserSupport: "variable",
  }),
  cerebras: compatibleProvider({
    id: "cerebras",
    name: "Cerebras",
    short: "Cerebras",
    color: "#f59e0b",
    logo: cerebrasLogo,
    keyPlaceholder: "csk-…",
    keyUrl: "https://cloud.cerebras.ai/platform",
    credentialLabel: "API key",
    modelsUrl: "https://api.cerebras.ai/v1/models",
    chatUrl: "https://api.cerebras.ai/v1/chat/completions",
    browserSupport: "variable",
  }),
  local: {
    id: "local",
    name: "Local",
    short: "Local",
    color: "#8b93a7",
    logo: LOCAL_LOGO,
    keyPlaceholder: "http://localhost:11434/v1",
    keyUrl: "",
    credentialLabel: "Base URL",
    credentialHelp: "Ollama · LM Studio · llama.cpp · vLLM · LocalAI",
    modelsUrl: "",
    chatUrl: "",
    browserSupport: "variable",
    headers: () => ({ "Content-Type": "application/json" }),
    body: openAIBody(false),
    parse: parseOpenAIChunk,
    parseModels: (json) => genericModels(json),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const PROVIDER_LIST = PROVIDER_IDS.map((id) => PROVIDERS[id]);
