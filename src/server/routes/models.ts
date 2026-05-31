import { Hono } from "hono";
import { getLimitConfig } from "../lib/limits.js";
import { configuredProviders } from "../providers/registry.js";
import { loadProviderOwners } from "../lib/provider-owners.js";

const models = new Hono();

/**
 * The id we expose to clients.
 *
 * Every provider namespaces its models with a short routing prefix
 * (`or/…`, whatever an admin set). The prefix is INTENTIONALLY shown to
 * users — it guarantees no cross-provider name collisions and it
 * round-trips: a client echoes `or/llama-3-70b` back and the registry
 * routes it straight to that provider. This is the identity function; it
 * stays as a single named seam in case display rules change again, and
 * so routes/discord.ts can mirror exactly one definition.
 */
export function publicModelId(id: string): string {
  return id;
}

/**
 * Shared model aggregation. Fans out to every configured provider in
 * parallel. A provider that errors contributes nothing rather than
 * failing the whole call.
 *
 * Admin-disabled providers (providers.enabled=false in Supabase, set via
 * the Providers panel) are filtered out here so their models never appear
 * in /v1/models or /api/models — exposing models a user can't actually
 * call would just produce 503s at request time.
 *
 * Invisible providers (providers.visible=false but still enabled) are
 * filtered out here too: they are fully callable but deliberately hidden
 * from every listing — a staging mode for testing a provider in production
 * before revealing it. Routing (resolveModel) does NOT go through this
 * function, so hiding here never affects callability.
 *
 * Exported so lib/status.ts can reuse the same enabled-provider rules
 * when building the model-health board (otherwise the board could
 * advertise a model that /v1/chat/completions would refuse).
 */
export async function aggregateModels() {
  const [limitCfg, providers] = await Promise.all([
    getLimitConfig(),
    configuredProviders(),
  ]);
  const enabled = providers.filter((p) => {
    const row = limitCfg.providers.get(p.id);
    // No row in DB → treat as enabled+visible (matches computeLimits'
    // default, and the safe fallback if the limit config can't load — never
    // silently hide everything on a DB hiccup).
    if (!row) return true;
    // Drop both disabled AND enabled-but-invisible providers from every
    // listing surface at once (models list, status board, Discord /models,
    // warmer all route through here).
    return row.enabled !== false && row.visible !== false;
  });
  const lists = await Promise.all(
    enabled.map((p) =>
      p.models().catch((err) => {
        console.error(`[models] ${p.id} failed:`, err);
        return [];
      }),
    ),
  );
  return lists.flat();
}

/**
 * GET /v1/models (auth required — handled by middleware in app.ts)
 * OpenAI-compatible. Model ids carry their routing prefix so clients can
 * paste them back verbatim.
 */
models.get("/v1/models", async (c) => {
  const data = (await aggregateModels()).map((m) => ({
    ...m,
    id: publicModelId(m.id),
  }));

  return c.json({ object: "list", data });
});

/**
 * GET /api/models (public, no auth)
 * Used by the landing page and dashboard. Mock models are excluded
 * (internal testing only). `name` and `id` are the same prefixed string —
 * exactly what a user pastes into their client.
 */
models.get("/api/models", async (c) => {
  // Parallel: model list + per-prefix owner chips. Each Claude model
  // card on the homepage gets its own owner chip (since the Premium
  // section pulls Claudes across providers), so the frontend joins
  // model→provider owner by the model id's routing prefix.
  const [all, providers] = await Promise.all([
    aggregateModels(),
    loadProviderOwners(),
  ]);

  const cleaned = all
    .filter((m) => !m.id.startsWith("mock/"))
    .map((m) => {
      const pub = publicModelId(m.id);
      return {
        id: pub,
        name: pub,
        owned_by: m.owned_by,
      };
    });

  return c.json({ models: cleaned, total: cleaned.length, providers });
});

export default models;
