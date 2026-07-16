/** Fixed-window counter stored in Cloudflare KV. Good enough for abuse control. */

export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface RateLimitConfig {
  /** Max successful publishes allowed in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Key prefix so other features can share the same namespace. */
  prefix?: string;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current window ends. */
  reset: number;
  retryAfterSec: number;
}

export const PUBLISH_RATE_LIMIT: RateLimitConfig = {
  limit: 10,
  windowSec: 60 * 60,
  prefix: "rl:publish",
};

export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "unknown";
}

export async function consumeRateLimit(
  store: RateLimitStore,
  keyPart: string,
  config: RateLimitConfig = PUBLISH_RATE_LIMIT,
): Promise<RateLimitResult> {
  const window = Math.floor(Date.now() / 1000 / config.windowSec);
  const reset = (window + 1) * config.windowSec;
  const retryAfterSec = Math.max(1, reset - Math.floor(Date.now() / 1000));
  const key = `${config.prefix || "rl"}:${keyPart}:${window}`;

  const current = Math.max(0, Number((await store.get(key)) || "0") || 0);
  if (current >= config.limit) {
    return {
      ok: false,
      limit: config.limit,
      remaining: 0,
      reset,
      retryAfterSec,
    };
  }

  const next = current + 1;
  // TTL a bit past the window so the key expires shortly after reset.
  await store.put(key, String(next), {
    expirationTtl: Math.max(60, config.windowSec + 60),
  });

  return {
    ok: true,
    limit: config.limit,
    remaining: Math.max(0, config.limit - next),
    reset,
    retryAfterSec,
  };
}
