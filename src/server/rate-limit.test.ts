import { describe, expect, it } from "vitest";
import {
  PUBLISH_RATE_LIMIT,
  clientIp,
  consumeRateLimit,
  type RateLimitStore,
} from "./rate-limit";

class MemoryKV implements RateLimitStore {
  store = new Map<string, string>();

  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

describe("clientIp", () => {
  it("prefers cf-connecting-ip, then x-forwarded-for", () => {
    expect(
      clientIp(
        new Request("https://battle.test", {
          headers: {
            "cf-connecting-ip": "1.2.3.4",
            "x-forwarded-for": "9.9.9.9, 8.8.8.8",
          },
        }),
      ),
    ).toBe("1.2.3.4");
    expect(
      clientIp(
        new Request("https://battle.test", {
          headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
        }),
      ),
    ).toBe("9.9.9.9");
    expect(clientIp(new Request("https://battle.test"))).toBe("unknown");
  });
});

describe("consumeRateLimit", () => {
  it("allows up to the limit and then blocks", async () => {
    const kv = new MemoryKV();
    const config = { ...PUBLISH_RATE_LIMIT, limit: 3, windowSec: 3600 };

    for (let i = 0; i < 3; i++) {
      const result = await consumeRateLimit(kv, "1.1.1.1", config);
      expect(result.ok).toBe(true);
      expect(result.remaining).toBe(2 - i);
    }

    const blocked = await consumeRateLimit(kv, "1.1.1.1", config);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("tracks clients independently", async () => {
    const kv = new MemoryKV();
    const config = { ...PUBLISH_RATE_LIMIT, limit: 1, windowSec: 3600 };

    expect((await consumeRateLimit(kv, "a", config)).ok).toBe(true);
    expect((await consumeRateLimit(kv, "b", config)).ok).toBe(true);
    expect((await consumeRateLimit(kv, "a", config)).ok).toBe(false);
  });
});
