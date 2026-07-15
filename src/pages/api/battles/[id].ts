import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getSharedBattle } from "../../../server/shared-battles";

export const prerender = false;

export const GET: APIRoute = ({ params }) =>
  getSharedBattle(params.id || "", env.BATTLES_DB);
