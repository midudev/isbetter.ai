import {
  MAX_SHARED_BATTLE_BYTES,
  SharedBattleValidationError,
  parseSharedBattleData,
  type SharedBattle,
} from "../scripts/shared-battle";
import {
  PUBLISH_RATE_LIMIT,
  clientIp,
  consumeRateLimit,
  type RateLimitStore,
} from "./rate-limit";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export interface BattlesDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ success: boolean }>;
      first<T>(): Promise<T | null>;
    };
  };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...jsonHeaders, ...init.headers },
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rateLimitHeaders(result: {
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSec: number;
}): HeadersInit {
  return {
    "cache-control": "no-store",
    "ratelimit-limit": String(result.limit),
    "ratelimit-remaining": String(result.remaining),
    "ratelimit-reset": String(result.reset),
    "retry-after": String(result.retryAfterSec),
  };
}

export async function createSharedBattle(
  request: Request,
  database: BattlesDatabase,
  rateLimitKv?: RateLimitStore | null,
): Promise<Response> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json"))
    return json({ error: "Expected application/json" }, { status: 415 });

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_SHARED_BATTLE_BYTES)
    return json({ error: "Battle payload is too large" }, { status: 413 });

  let rate:
    | Awaited<ReturnType<typeof consumeRateLimit>>
    | undefined;
  if (rateLimitKv) {
    try {
      rate = await consumeRateLimit(
        rateLimitKv,
        clientIp(request),
        PUBLISH_RATE_LIMIT,
      );
    } catch {
      // Fail closed: without rate limiting, anonymous publish is too easy to abuse.
      return json(
        { error: "Publish temporarily unavailable. Try again shortly." },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    if (rate && !rate.ok) {
      return json(
        {
          error: `Rate limit exceeded. Try again in ${rate.retryAfterSec}s.`,
        },
        {
          status: 429,
          headers: rateLimitHeaders(rate),
        },
      );
    }
  }

  const body = await request.text();
  if (byteLength(body) > MAX_SHARED_BATTLE_BYTES)
    return json({ error: "Battle payload is too large" }, { status: 413 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }

  let payload: string;
  try {
    payload = JSON.stringify(parseSharedBattleData(parsed));
  } catch (error) {
    const message =
      error instanceof SharedBattleValidationError ? error.message : "Invalid battle";
    return json({ error: message }, { status: 400 });
  }
  if (byteLength(payload) > MAX_SHARED_BATTLE_BYTES)
    return json({ error: "Battle payload is too large" }, { status: 413 });

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  try {
    const result = await database
      .prepare(
        "INSERT INTO shared_battles (id, created_at, payload) VALUES (?1, ?2, ?3)",
      )
      .bind(id, createdAt, payload)
      .run();
    if (!result.success) throw new Error("D1 insert failed");
  } catch {
    return json({ error: "Could not publish this battle" }, { status: 503 });
  }

  const publicUrl = new URL("/battle", request.url);
  publicUrl.searchParams.set("id", id);
  return json(
    { id, url: publicUrl.toString() },
    {
      status: 201,
      headers: {
        "cache-control": "no-store",
        ...(rate
          ? {
              "ratelimit-limit": String(rate.limit),
              "ratelimit-remaining": String(rate.remaining),
              "ratelimit-reset": String(rate.reset),
            }
          : {}),
      },
    },
  );
}

export async function getSharedBattle(
  id: string,
  database: BattlesDatabase,
): Promise<Response> {
  if (!UUID_PATTERN.test(id))
    return json({ error: "Battle not found" }, { status: 404 });

  let row: { payload: string } | null;
  try {
    row = await database
      .prepare("SELECT payload FROM shared_battles WHERE id = ?1")
      .bind(id)
      .first<{ payload: string }>();
  } catch {
    return json({ error: "Could not load this battle" }, { status: 503 });
  }
  if (!row) return json({ error: "Battle not found" }, { status: 404 });

  try {
    const data = parseSharedBattleData(JSON.parse(row.payload));
    const battle: SharedBattle = { id, ...data };
    return json(battle, {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    return json({ error: "Stored battle is invalid" }, { status: 500 });
  }
}
