import { describe, expect, it } from "vitest";
import { modelBrandFor } from "./model-icons";

describe("OpenRouter model aliases", () => {
  it.each([
    ["~anthropic/claude-opus-latest", "Anthropic"],
    ["~openai/gpt-5.5-latest", "OpenAI"],
    ["~google/gemini-pro-latest", "Google"],
    ["~x-ai/grok-latest", "xAI"],
    ["~moonshotai/kimi-latest", "Moonshot AI"],
  ])("resolves the brand for %s", (modelId, brand) => {
    expect(modelBrandFor(modelId)?.name).toBe(brand);
  });
});
