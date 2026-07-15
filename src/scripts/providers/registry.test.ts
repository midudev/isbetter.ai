import { describe, expect, it } from "vitest";
import {
  parseAnthropicChunk,
  parseOpenAIChunk,
  priceFor,
  PROVIDER_IDS,
  PROVIDERS,
} from "./registry";

describe("provider registry", () => {
  it("contains every supported direct provider", () => {
    expect(PROVIDER_IDS).toEqual(
      expect.arrayContaining([
        "openrouter",
        "openai",
        "anthropic",
        "google",
        "xai",
        "deepseek",
        "mistral",
        "groq",
        "cerebras",
        "local",
      ]),
    );
    expect(PROVIDERS.google.chatUrl).toContain("/openai/chat/completions");
    expect(PROVIDERS.anthropic.body("claude-fable-5", "", "")).toMatchObject({
      max_tokens: 16384,
    });
    expect(PROVIDERS.anthropic.body("claude-opus-4-8", "", "")).toMatchObject({
      max_tokens: 8192,
    });
  });

  it("normalizes OpenAI-compatible content, reasoning and usage", () => {
    expect(
      parseOpenAIChunk({
        choices: [
          {
            delta: { content: "answer", reasoning_content: "thought" },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    ).toEqual({
      content: "answer",
      reasoning: "thought",
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      finishReason: "length",
    });
  });

  it("normalizes Anthropic usage events", () => {
    expect(
      parseAnthropicChunk({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 12 },
      }),
    ).toEqual({
      content: "",
      reasoning: "",
      usage: { completion_tokens: 12 },
      finishReason: "max_tokens",
    });
  });

  it("returns configured model pricing and null when unknown", () => {
    expect(priceFor("groq", "unknown-model")).toBeNull();
    expect(priceFor("deepseek", "deepseek-v4-flash")).toEqual({
      prompt: 0.14 / 1e6,
      completion: 0.28 / 1e6,
    });
    expect(priceFor("anthropic", "claude-fable-5")).toEqual({
      prompt: 10 / 1e6,
      completion: 50 / 1e6,
    });
  });
});
