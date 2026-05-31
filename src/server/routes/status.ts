/**
 * Authenticated model-health endpoint backing the /status dashboard
 * page.
 *
 *   GET /api/status                → JSON: { generatedAt, models: ModelStatus[] }
 *   GET /api/status?format=text    → text/plain ASCII strip rendering
 *
 * Both formats require a valid Discord OAuth session JWT in the
 * `Authorization: Bearer …` header. The visual page at /status (a
 * React component) calls this endpoint with the JWT it stashed in
 * localStorage during the OAuth flow.
 *
 * Public exposure of the model-health board lives ONLY on the Discord
 * channel posts (lib/discord-status.ts). This endpoint and the visual
 * page are gated because the user explicitly chose login-only access:
 * uptime monitors and unauthenticated curl can use Discord, not HTTP.
 *
 * One source of truth lives in lib/status.ts — both formats render off
 * the same computeStatus() result.
 */

import { Hono } from "hono";
import { computeStatus, renderText } from "../lib/status.js";
import { getSessionUser } from "../lib/session.js";
import { loadProviderOwners } from "../lib/provider-owners.js";

const status = new Hono();

status.get("/api/status", async (c) => {
  const user = await getSessionUser(c.req.header("Authorization"));
  if (!user) return c.json({ error: "Not authenticated" }, 401);

  const generatedAt = new Date();
  const [models, providers] = await Promise.all([
    computeStatus(),
    loadProviderOwners(),
  ]);

  if (c.req.query("format") === "text") {
    return c.text(renderText(models, generatedAt), 200, {
      "Cache-Control": "no-cache",
    });
  }

  return c.json({
    generatedAt: generatedAt.toISOString(),
    models,
    providers,
  });
});

export default status;
