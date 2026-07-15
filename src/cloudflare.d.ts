declare module "cloudflare:workers" {
  export const env: {
    BATTLES_DB: import("./server/shared-battles").BattlesDatabase;
  };
}
