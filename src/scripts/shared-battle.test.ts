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
import type { RateLimitStore } from "../server/rate-limit";
import { PUBLISH_RATE_LIMIT } from "../server/rate-limit";

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

class MemoryKV implements RateLimitStore {
  store = new Map<string, string>();

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.store.set(key, value);
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

  it("allowlists only anonymous public fields — no identity, keys, system prompt or reasoning", () => {
    const shared = toSharedBattleData(battleFixture());

    expect(Object.keys(shared).sort()).toEqual(
      ["blind", "prompt", "results", "schemaVersion", "ts"].sort(),
    );
    expect(shared).not.toHaveProperty("system");
    expect(shared).not.toHaveProperty("sharedId");
    expect(shared).not.toHaveProperty("id");

    expect(Object.keys(shared.results[0]).sort()).toEqual(
      [
        "code",
        "completionTokens",
        "cost",
        "costKnown",
        "durationMs",
        "genMs",
        "id",
        "key",
        "label",
        "metrics",
        "promptTokens",
        "provider",
        "raw",
        "state",
        "totalTokens",
        "ttftMs",
        "usageEstimated",
      ].sort(),
    );
    expect(shared.results[0]).not.toHaveProperty("reasoning");
    expect(shared.results[0]).not.toHaveProperty("error");
    expect(shared.results[0]).not.toHaveProperty("warning");
  });

  it("strips injected personal fields before storing, even if a client sends them", async () => {
    const database = new MemoryDatabase();
    const dirty = {
      ...toSharedBattleData(battleFixture()),
      system: "should never be stored",
      apiKey: "sk-secret-key",
      email: "user@example.com",
      userId: "user-123",
      results: [
        {
          ...toSharedBattleData(battleFixture()).results[0],
          reasoning: "private thoughts",
          error: "secret error",
          warning: "secret warning",
          apiKey: "sk-in-result",
        },
      ],
    };
    const created = await createSharedBattle(
      new Request("https://battle.test/api/battles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dirty),
      }),
      database,
    );
    expect(created.status).toBe(201);
    const stored = [...database.rows.values()][0];
    expect(stored).not.toContain("should never be stored");
    expect(stored).not.toContain("sk-secret-key");
    expect(stored).not.toContain("user@example.com");
    expect(stored).not.toContain("user-123");
    expect(stored).not.toContain("private thoughts");
    expect(stored).not.toContain("secret error");
    expect(stored).not.toContain("secret warning");
    expect(stored).not.toContain("sk-in-result");
    expect(stored).not.toContain('"system"');
    expect(stored).not.toContain('"apiKey"');
    expect(stored).not.toContain('"email"');
    expect(stored).not.toContain('"reasoning"');
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

  it("rate-limits publishes per IP via KV", async () => {
    const database = new MemoryDatabase();
    const kv = new MemoryKV();
    const payload = JSON.stringify(toSharedBattleData(battleFixture()));
    const post = () =>
      createSharedBattle(
        new Request("https://battle.test/api/battles", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.10",
          },
          body: payload,
        }),
        database,
        kv,
      );

    for (let i = 0; i < PUBLISH_RATE_LIMIT.limit; i++) {
      expect((await post()).status).toBe(201);
    }

    const limited = await post();
    const body = (await limited.json()) as { error: string };
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(body.error).toMatch(/rate limit/i);
    expect(database.rows.size).toBe(PUBLISH_RATE_LIMIT.limit);
  });

  it("fails closed when rate-limit KV is unavailable", async () => {
    const database = new MemoryDatabase();
    const kv: RateLimitStore = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };

    const response = await createSharedBattle(
      new Request("https://battle.test/api/battles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.10",
        },
        body: JSON.stringify(toSharedBattleData(battleFixture())),
      }),
      database,
      kv,
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).toMatch(/unavailable/i);
    expect(database.rows.size).toBe(0);
  });
});
