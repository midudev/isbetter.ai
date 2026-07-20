import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { createSharedBattle } from "../../../server/shared-battles";

export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  createSharedBattle(request, env.BATTLES_DB, env.RATE_LIMIT_KV, env.AI);
