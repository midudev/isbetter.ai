import { describe, expect, it } from "vitest";
import {
  MAX_METRIC_SAMPLES,
  renderMetricsTimeline,
  type Battle,
  type MetricSample,
} from "./lib";
import {
  MAX_SHARED_BATTLE_BYTES,
  parseSharedBattle,
  sharedBattleToBattle,
  toSharedBattleData,
} from "./shared-battle";
import {
  createSharedBattle,
  getSharedBattle,
  type BattlesDatabase,
} from "../server/shared-battles";

const metrics: MetricSample[] = Array.from({ length: 120 }, (_, index) => ({
  tMs: index * 100,
  completionTokens: index * 4,
  cost: index * 0.00001,
  costKnown: true,
  estimated: index < 119,
}));

function battleFixture(): Battle {
  return {
    id: "local-1",
    schemaVersion: 3,
    ts: 123,
    prompt: "Build a demo",
    system: "private system prompt",
    results: [
      {
        id: "model",
        key: "openai::model",
        provider: "openai",
        label: "Model",
        raw: "Done\n```html\n<!doctype html><p>Hello</p>\n```",
        reasoning: "private reasoning",
        code: "<!doctype html><p>Hello</p>",
        state: "done",
        error: "",
        promptTokens: 10,
        completionTokens: 476,
        totalTokens: 486,
        cost: 0.01,
        costKnown: true,
        usageEstimated: false,
        durationMs: 12_000,
        ttftMs: 100,
        genMs: 11_900,
        metrics,
      },
      {
        id: "failed",
        key: "openai::failed",
        provider: "openai",
        label: "Failed",
        raw: "",
        code: "",
        state: "error",
        error: "private provider error",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        durationMs: 50,
      },
    ],
  };
}

class MemoryDatabase implements BattlesDatabase {
  rows = new Map<string, string>();

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (!query.startsWith("INSERT")) return { success: false };
          this.rows.set(String(values[0]), String(values[2]));
          return { success: true };
        },
        first: async <T>() => {
          const payload = this.rows.get(String(values[0]));
          return (payload ? { payload } : null) as T | null;
        },
      }),
    };
  }
}

describe("shared battle sanitizing", () => {
  it("keeps public chart data and removes private fields and failed requests", () => {
    const shared = toSharedBattleData(battleFixture());
    const serialized = JSON.stringify(shared);

    expect(shared.results).toHaveLength(1);
    expect(shared.results[0].metrics).toHaveLength(MAX_METRIC_SAMPLES);
    expect(shared.results[0].metrics[0]).toEqual(metrics[0]);
    expect(shared.results[0].metrics.at(-1)).toEqual(metrics.at(-1));
    expect(serialized).not.toContain("private system prompt");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("private provider error");
    expect(serialized).not.toContain("apiKey");
  });

  it("rebuilds the timeline after a public round trip", () => {
    const publicBattle = parseSharedBattle({
      id: "public-id",
      ...toSharedBattleData(battleFixture()),
    });
    const restored = sharedBattleToBattle(publicBattle);
    const result = restored.results[0];
    const timeline = renderMetricsTimeline([
      {
        key: result.key!,
        id: result.id,
        provider: result.provider,
        label: result.label,
        state: result.state,
        durationMs: result.durationMs,
        completionTokens: result.completionTokens,
        cost: result.cost,
        costKnown: result.costKnown,
        metrics: result.metrics,
      },
    ]);

    expect(restored.system).toBe("");
    expect(timeline).toContain("Tokens and cost generated over time");
    expect(timeline).toContain("<path");
  });
});

describe("shared battle API handlers", () => {
  it("stores and retrieves a sanitized immutable battle", async () => {
    const database = new MemoryDatabase();
    const request = new Request("https://battle.test/api/battles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toSharedBattleData(battleFixture())),
    });
    const created = await createSharedBattle(request, database);
    const createdBody = (await created.json()) as { id: string; url: string };

    expect(created.status).toBe(201);
    expect(createdBody.url).toBe(
      `https://battle.test/battle?id=${createdBody.id}`,
    );

    const loaded = await getSharedBattle(createdBody.id, database);
    const loadedBody = parseSharedBattle(await loaded.json());
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(loadedBody.results[0].metrics).toHaveLength(MAX_METRIC_SAMPLES);
  });

  it("rejects oversized and invalid requests before writing", async () => {
    const database = new MemoryDatabase();
    const oversized = await createSharedBattle(
      new Request("https://battle.test/api/battles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_SHARED_BATTLE_BYTES + 1),
        },
        body: "{}",
      }),
      database,
    );
    const invalid = await createSharedBattle(
      new Request("https://battle.test/api/battles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, results: [] }),
      }),
      database,
    );

    expect(oversized.status).toBe(413);
    expect(invalid.status).toBe(400);
    expect(database.rows.size).toBe(0);
  });
});
