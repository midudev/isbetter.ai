export type ProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "mistral"
  | "groq"
  | "cerebras"
  | "local";

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface Chunk {
  content: string;
  reasoning: string;
  usage: UsageInfo | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  promptPrice: number | null;
  completionPrice: number | null;
  context: number;
}

export interface Provider {
  id: ProviderId;
  name: string;
  short: string;
  color: string;
  logo: string;
  logoMonochrome?: boolean;
  keyPlaceholder: string;
  keyUrl: string;
  credentialLabel: string;
  credentialHelp?: string;
  modelsUrl: string;
  chatUrl: string;
  browserSupport: "supported" | "variable";
  headers: (credential: string) => Record<string, string>;
  body: (model: string, system: string, user: string) => object;
  parse: (json: unknown) => Chunk;
  parseModels: (json: unknown) => ModelInfo[];
}
