/**
 * Provider registry — DB-driven.
 *
 *   - `providers` rows in the DB define every provider: a stable `id`
 *     (the request_logs.via / limits key), a user-facing `prefix`, and —
 *     for kind='openai' — a base_url + api_key. Admins add/edit them from
 *     the dashboard; no redeploy.
 *   - `provider_models` rows define each dynamic provider's catalog:
 *     upstream_id, a maskable display_name, an enabled flag. Populated
 *     from the upstream's /v1/models at add/refresh time, then editable.
 *   - Mock (id='mock') is the only code provider; everything else
 *     (OpenRouter, anything an admin adds) runs through the generic
 *     engine in dynamic.ts.
 *
 * Routing (resolveModel): every request must use a registered provider
 * prefix. There is no DEFAULT_PROVIDER fallback any more — a model name
 * without a known prefix returns 400 with guidance.
 *
 * Config is cached 30s per warm instance. Admin writes call
 * invalidateProviderRegistry(). Fail-safe: on a DB error we serve the
 * last good snapshot, else a code-only snapshot (mock) so a DB hiccup
 * degrades dynamic providers but never takes the whole proxy down.
 */

import { getDb, hasDb } from "../lib/db.js";
import { mockProvider } from "./mock.js";
import {
  makeOpenAIProvider,
  type ProviderConfig,
  type ResolvedModel,
} from "./dynamic.js";
import { ProviderError, type ChatProvider } from "./types.js";

/** What resolveModel hands back: which provider, and the exact upstream id. */
export type Resolution = { provider: ChatProvider; upstreamId: string };

type Snapshot = {
  /** id → provider (configured or not). */
  byId: Map<string, ChatProvider>;
  /** Every provider, for /health. */
  all: ChatProvider[];
  /** prefix (lowercased) → provider id. */
  prefixToId: Map<string, string>;
  /** providerId → (lowercased display name → upstream id). */
  displayToUpstream: Map<string, Map<string, string>>;
  /** Set of provider ids whose catalog is the authoritative source of
   *  truth (kind='openai' only — i.e. dynamic DB-driven providers).
   *  resolveModel uses this to refuse unknown ids on these providers,
   *  so a `vx/<disabled-or-unknown>` request returns 404 instead of
   *  silently forwarding. Mock is intentionally NOT in this set — its
   *  model list is hardcoded in `provider.models()` and unknown ids
   *  fall through to lorem. */
  strictCatalog: Set<string>;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: Snapshot; expiresAt: number } | null = null;
let lastGood: Snapshot | null = null;

/** Built-in code providers, keyed by the DB row id that maps to them. */
const BUILTINS: Record<string, ChatProvider> = {
  mock: mockProvider,
};

type ProviderRow = {
  id: string;
  kind: string | null;
  prefix: string | null;
  base_url: string | null;
  api_key: string | null;
  extra_headers: Record<string, string> | null;
};

type ModelRow = {
  provider_id: string;
  upstream_id: string;
  display_name: string;
  enabled: boolean;
  owned_by: string | null;
};

/**
 * A code-only snapshot (mock). Used as the ultimate fallback when the
 * database isn't configured or errors and we have no last-good snapshot
 * yet. The prefix is fixed ('mock').
 */
function codeOnlySnapshot(): Snapshot {
  const byId = new Map<string, ChatProvider>();
  const prefixToId = new Map<string, string>();
  const all: ChatProvider[] = [];
  for (const [id, provider] of Object.entries(BUILTINS)) {
    byId.set(id, provider);
    prefixToId.set(id, id);
    all.push(provider);
  }
  return {
    byId,
    all,
    prefixToId,
    displayToUpstream: new Map(),
    strictCatalog: new Set(),
  };
}

async function indexBuiltinModels(
  provider: ChatProvider,
  snap: Snapshot,
): Promise<void> {
  let list: Awaited<ReturnType<ChatProvider["models"]>>;
  try {
    list = await provider.models();
  } catch {
    return;
  }
  const d2u = snap.displayToUpstream.get(provider.id) ?? new Map();
  for (const m of list) {
    const slash = m.id.indexOf("/");
    const tail = slash === -1 ? m.id : m.id.slice(slash + 1);
    d2u.set(tail.toLowerCase(), tail);
  }
  snap.displayToUpstream.set(provider.id, d2u);
}

async function load(): Promise<Snapshot> {
  if (!hasDb()) return lastGood ?? codeOnlySnapshot();

  let providers: ProviderRow[];
  let models: ModelRow[];
  try {
    const sql = getDb();
    [providers, models] = await Promise.all([
      sql<ProviderRow[]>`
        select id, kind, prefix, base_url, api_key, extra_headers
        from providers
      `,
      sql<ModelRow[]>`
        select provider_id, upstream_id, display_name, enabled, owned_by
        from provider_models
        where enabled = true
      `,
    ]);
  } catch (err) {
    console.error("[registry] DB read failed:", (err as Error).message);
    return lastGood ?? codeOnlySnapshot();
  }

  // Group enabled models per provider.
  const modelsByProvider = new Map<string, ResolvedModel[]>();
  for (const m of models) {
    const arr = modelsByProvider.get(m.provider_id) ?? [];
    arr.push({
      upstreamId: m.upstream_id,
      displayName: m.display_name,
      ownedBy: m.owned_by,
    });
    modelsByProvider.set(m.provider_id, arr);
  }

  const snap: Snapshot = {
    byId: new Map(),
    all: [],
    prefixToId: new Map(),
    displayToUpstream: new Map(),
    strictCatalog: new Set(),
  };

  for (const row of providers) {
    const prefix = (row.prefix || row.id).trim();
    const kind = row.kind ?? "builtin";

    let provider: ChatProvider | null = null;
    if (kind === "builtin") {
      provider = BUILTINS[row.id] ?? null;
      if (!provider) {
        console.warn(
          `[registry] provider '${row.id}' is kind='builtin' but no code provider is registered for it — skipping.`,
        );
        continue;
      }
    } else if (kind === "openai") {
      const cfg: ProviderConfig = {
        id: row.id,
        prefix,
        baseUrl: row.base_url ?? "",
        apiKey: row.api_key ?? "",
        extraHeaders: row.extra_headers ?? undefined,
      };
      provider = makeOpenAIProvider(cfg, modelsByProvider.get(row.id) ?? []);
    } else {
      console.warn(`[registry] provider '${row.id}' has unknown kind '${kind}' — skipping.`);
      continue;
    }

    snap.byId.set(row.id, provider);
    snap.all.push(provider);
    snap.prefixToId.set(prefix.toLowerCase(), row.id);

    if (kind === "openai") {
      const d2u = new Map<string, string>();
      for (const m of modelsByProvider.get(row.id) ?? []) {
        d2u.set(m.displayName.toLowerCase(), m.upstreamId);
      }
      snap.displayToUpstream.set(row.id, d2u);
      // Dynamic providers have an authoritative catalog. Mark them so
      // resolveModel refuses ids that aren't in it (which excludes
      // disabled rows, since we filtered .eq('enabled', true) on load).
      snap.strictCatalog.add(row.id);
    }
  }

  // Make sure code built-ins exist even if their DB row is missing.
  for (const [id, provider] of Object.entries(BUILTINS)) {
    if (!snap.byId.has(id)) {
      snap.byId.set(id, provider);
      snap.all.push(provider);
      snap.prefixToId.set(id, id);
    }
    await indexBuiltinModels(provider, snap);
  }

  lastGood = snap;
  return snap;
}

async function getSnapshot(): Promise<Snapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = await load();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Drop the cached snapshot after an admin write so changes apply at once. */
export function invalidateProviderRegistry(): void {
  cache = null;
}

function ensureConfigured(provider: ChatProvider): ChatProvider {
  if (!provider.isConfigured()) {
    throw new ProviderError(
      `Provider '${provider.id}' is not configured (missing credentials).`,
      provider.id,
      503,
    );
  }
  return provider;
}

/**
 * Resolve a user-supplied model string to a concrete provider + the exact
 * id to forward upstream. Every model name MUST start with a registered
 * provider prefix (e.g. `or/llama-3-70b`); bare names get 400.
 *
 * Throws ProviderError 400 if the prefix is missing/unknown, 404 if the
 * model isn't enabled on a strict-catalog provider, or 503 if the chosen
 * provider isn't configured.
 */
export async function resolveModel(model: string): Promise<Resolution> {
  const snap = await getSnapshot();
  const raw = (model ?? "").trim();
  const knownPrefixes = [...snap.prefixToId.keys()].sort().join(", ");

  const slashIdx = raw.indexOf("/");
  if (slashIdx === -1) {
    throw new ProviderError(
      `Model name '${raw}' must include a provider prefix (e.g. or/<model>). Known prefixes: ${knownPrefixes || "(none configured)"}.`,
      "(none)",
      400,
    );
  }

  const maybePrefix = raw.slice(0, slashIdx).toLowerCase();
  const providerId = snap.prefixToId.get(maybePrefix);
  if (!providerId) {
    throw new ProviderError(
      `Unknown provider prefix '${maybePrefix}'. Known prefixes: ${knownPrefixes || "(none configured)"}.`,
      maybePrefix,
      400,
    );
  }

  const provider = snap.byId.get(providerId)!;
  const rest = raw.slice(slashIdx + 1);
  const d2u = snap.displayToUpstream.get(providerId);
  const known = d2u?.get(rest.toLowerCase());
  if (known !== undefined) {
    return { provider: ensureConfigured(provider), upstreamId: known };
  }

  // Strict-catalog providers (kind='openai') only serve what the admin
  // has explicitly enabled in provider_models.
  if (snap.strictCatalog.has(providerId)) {
    throw new ProviderError(
      `Model '${raw}' is not enabled on provider '${providerId}'.`,
      providerId,
      404,
    );
  }

  // Code built-ins (mock) forward the bare id to the provider as an
  // escape hatch.
  return { provider: ensureConfigured(provider), upstreamId: rest };
}

/** All currently-configured providers, e.g. for /v1/models aggregation. */
export async function configuredProviders(): Promise<ChatProvider[]> {
  const snap = await getSnapshot();
  return snap.all.filter((p) => p.isConfigured());
}

/** All providers, configured or not. For /health diagnostics. */
export async function allProviders(): Promise<ChatProvider[]> {
  const snap = await getSnapshot();
  return [...snap.all];
}

/**
 * Map of user-facing routing prefix (lowercased) → provider id.
 *
 * These two are the SAME string for most providers, but they can diverge:
 * a provider keeps a stable `id` (the key `request_logs.via` and the limit
 * tables reference) while its user-facing `prefix` is renamed. Anything
 * that needs to go from a model-id prefix back to the `via` value — e.g.
 * lib/status.ts building the health board — must translate through this
 * map rather than assuming prefix === id.
 *
 * Returns a copy so callers can't mutate the cached snapshot. Hits the
 * same 30s-cached snapshot as resolveModel, so no extra DB round-trip in
 * the common case.
 */
export async function prefixToProviderId(): Promise<Map<string, string>> {
  const snap = await getSnapshot();
  return new Map(snap.prefixToId);
}
