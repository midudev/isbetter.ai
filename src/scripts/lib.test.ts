import { beforeEach, describe, expect, it } from "vitest";
import {
  extractAnswer,
  extractCode,
  HISTORY_KEY,
  downsampleMetricSamples,
  loadHistory,
  renderBattleInsights,
  renderMetricsTimeline,
  saveHistory,
  statsRowHTML,
  type Battle,
  type MetricSample,
} from "./lib";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

describe("result extraction", () => {
  const response = `A concise explanation.\n\n\`\`\`html\n<!doctype html><p>Hello</p>\n\`\`\``;

  it("extracts a renderable HTML document", () => {
    expect(extractCode(response)).toContain("<!doctype html>");
  });

  it("keeps output readable by removing fenced source", () => {
    expect(extractAnswer(response)).toBe("A concise explanation.");
  });
});

describe("history migration", () => {
  it("adds a stable composite key to legacy results", () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        {
          id: "1",
          ts: 1,
          prompt: "test",
          system: "system",
          results: [
            {
              id: "gpt-test",
              provider: "openai",
              label: "GPT",
              raw: "ok",
              code: "",
              state: "done",
              error: "",
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              cost: 0,
              durationMs: 100,
              genMs: 80,
            },
          ],
        },
      ]),
    );

    const [battle] = loadHistory();
    expect(battle.schemaVersion).toBe(3);
    expect(battle.results[0]).toMatchObject({
      key: "openai::gpt-test",
      ttftMs: 20,
      costKnown: false,
    });
  });

  it("persists the current schema version and blind-mode mapping", () => {
    const battle: Battle = {
      id: "1",
      ts: 1,
      prompt: "",
      system: "",
      results: [],
      blind: {
        enabled: true,
        revealed: false,
        order: ["openai::model"],
        aliases: { "openai::model": "Model A" },
      },
    };
    saveHistory([battle]);
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")[0];
    expect(saved.schemaVersion).toBe(3);
    expect(saved.blind.aliases["openai::model"]).toBe("Model A");
  });
});

describe("metric timelines", () => {
  const samples: MetricSample[] = Array.from({ length: 120 }, (_, index) => ({
    tMs: index * 250,
    completionTokens: index * 10,
    cost: index * 0.0001,
    costKnown: true,
    estimated: index < 119,
  }));

  it("limits samples while preserving both endpoints", () => {
    const reduced = downsampleMetricSamples(samples, 20);
    expect(reduced).toHaveLength(20);
    expect(reduced[0]).toEqual(samples[0]);
    expect(reduced.at(-1)).toEqual(samples.at(-1));
  });

  it("renders an accessible SVG timeline and model legend", () => {
    const html = renderMetricsTimeline([
      {
        key: "openai::model",
        id: "model",
        provider: "openai",
        label: "Model A",
        state: "done",
        durationMs: 30_000,
        completionTokens: 1_190,
        cost: 0.0119,
        metrics: samples,
      },
    ]);
    expect(html).toContain("<svg");
    expect(html).toContain("Tokens and cost generated over time");
    expect(html).toContain("Model A");
    expect(html).toContain("<path");
    expect(html).toContain('stroke-dasharray="7 6"');
    expect(html).toContain("&quot;tMs&quot;:0");
  });

  it("keeps tokens visible when cost history is unavailable", () => {
    const html = renderMetricsTimeline([
      {
        key: "local::model",
        id: "model",
        label: "Local model",
        state: "done",
        durationMs: 1_000,
        completionTokens: 10,
        cost: 0,
        costKnown: false,
        metrics: samples.map((sample) => ({ ...sample, costKnown: false })),
      },
    ]);
    expect(html).toContain("Tokens and cost generated over time");
    expect(html).not.toContain('stroke-dasharray="7 6"');
  });

  it("renders compact battle insights beside the chart", () => {
    const html = renderBattleInsights([
      {
        key: "openai::model",
        id: "model",
        label: "Model A",
        state: "done",
        durationMs: 2_000,
        genMs: 1_500,
        completionTokens: 200,
        cost: 0.01,
        costKnown: true,
      },
    ]);
    expect(html).toContain("Battle at a glance");
    expect(html).toContain("200");
    expect(html).toContain("$0.0100");
    expect(html).toContain("Model A");
  });
});

describe("metric tooltips", () => {
  it("renders keyboard-focusable tooltip triggers with useful copy", () => {
    const html = statsRowHTML({
      durationMs: 2_000,
      ttftMs: 300,
      genMs: 1_700,
      promptTokens: 100,
      completionTokens: 200,
      cost: 0.01,
      costKnown: true,
    });
    expect(html).toContain('data-metric-tooltip="total time — request to finish"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('title="total time');
  });
});
