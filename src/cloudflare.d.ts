declare module "cloudflare:workers" {
  export const env: {
    BATTLES_DB: import("./server/shared-battles").BattlesDatabase;
    RATE_LIMIT_KV: import("./server/rate-limit").RateLimitStore;
    AI: import("./server/code-security-types").AiBinding;
  };
}
