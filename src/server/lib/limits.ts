/**
 * Tier / provider limit configuration + the per-request resolution rule.
 *
 * Three independent metrics (rpm, rpd, tpd) and three gates a /v1 request
 * must all pass (enforcement lives in lib/usage-limit.ts; this module only
 * resolves the *numbers*):
 *
 *   Gate 1 — overall (the user, across ALL providers):
 *       tier.<metric>  →  app_config global  →  hardcoded default
 *     (app-config.ts already folds the hardcoded fallback in, so the
 *      overall number is always a positive int.)
 *
 *   Gate 2 — per-provider, per-user (the user, on THIS provider only):
 *       tier_provider_limits[tier][P].<metric>
 *         →  providers[P].per_user_<metric>
 *         →  null  (not enforced)
 *
 *   Gate 3 — per-provider, global (ALL users combined on THIS provider):
 *       providers[P].global_<metric>  →  null  (not enforced)
 *
 * A user's tier is the highest-`priority` tier whose `discord_role_id` is
 * in their Discord roles; ties broken by lowest id for determinism. No
 * matching tier → no tier → overall falls to the app_config global.
 *
 * NULL / non-positive limit = "not enforced" for that metric (a 0 or
 * negative cap would lock everyone out by accident; treat it as unset).
 *
 * Config is cached 3 min per warm instance (same rationale as lib/bans.ts /
 * lib/app-config.ts) since it's read on every /v1 request. Admin writes
 * call invalidateLimitConfig(). Fail-safe: a DB error yields empty config
 * (no tiers, no provider caps) so Gate 1's global default still applies
 * and requests aren't hard-blocked by a config read hiccup.
 */

import { getDb, hasDb } from "./db.js";
import type { AppConfig } from "./app-config.js";

export type Tier = {
  id: number;
  name: string;
  discordRoleId: string;
  priority: number;
  rpm: number | null;
  rpd: number | null;
  tpd: number | null;
};

export type ProviderLimits = {
  id: string;
  enabled: boolean;
  /** False = hidden from /v1/models, /api/models, and the status board,
   *  but still callable. Independent of `enabled`. */
  visible: boolean;
  perUserRpm: number | null;
  perUserRpd: number | null;
  perUserTpd: number | null;
  globalRpm: number | null;
  globalRpd: number | null;
  globalTpd: number | null;
};

export type LimitConfig = {
  tiers: Tier[];
  /** key = `${tierId}:${providerId}` */
  overrides: Map<string, { rpm: number | null; rpd: number | null; tpd: number | null }>;
  providers: Map<string, ProviderLimits>;
};

export type Triple = { rpm: number; rpd: number; tpd: number };
export type NullableTriple = {
  rpm: number | null;
  rpd: number | null;
  tpd: number | null;
};

export type EffectiveLimits = {
  tier: Tier | null;
  /** false only when an explicit providers row has enabled=false. */
  providerEnabled: boolean;
  /** Gate 1 — always positive ints. */
  overall: Triple;
  /** Gate 2 — null metric = not enforced. */
  providerPerUser: NullableTriple;
  /** Gate 3 — null metric = not enforced. */
  providerGlobal: NullableTriple;
};

/** Coerce a DB numeric to a positive int, or null (unset / non-positive). */
function posOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

const CACHE_TTL_MS = 180_000; // 3 min
let cache: { value: LimitConfig; expiresAt: number } | null = null;

const EMPTY: LimitConfig = {
  tiers: [],
  overrides: new Map(),
  providers: new Map(),
};

async function load(): Promise<LimitConfig> {
  if (!hasDb()) return EMPTY;
  try {
    const sql = getDb();
    type TierRow = { id: number; name: string; discord_role_id: string; priority: number | null; rpm: number | null; rpd: number | null; tpd: number | null };
    type OvRow = { tier_id: number; provider_id: string; rpm: number | null; rpd: number | null; tpd: number | null };
    type ProvRow = { id: string; enabled: boolean | null; visible: boolean | null; per_user_rpm: number | null; per_user_rpd: number | null; per_user_tpd: number | null; global_rpm: number | null; global_rpd: number | null; global_tpd: number | null };

    const [tiersData, ovData, provData] = await Promise.all([
      sql<TierRow[]>`select id, name, discord_role_id, priority, rpm, rpd, tpd from tiers`,
      sql<OvRow[]>`select tier_id, provider_id, rpm, rpd, tpd from tier_provider_limits`,
      sql<ProvRow[]>`select id, enabled, visible, per_user_rpm, per_user_rpd, per_user_tpd, global_rpm, global_rpd, global_tpd from providers`,
    ]);

    const tiers: Tier[] = tiersData.map((r) => ({
      id: Number(r.id),
      name: r.name,
      discordRoleId: r.discord_role_id,
      priority: Number(r.priority ?? 0),
      rpm: posOrNull(r.rpm),
      rpd: posOrNull(r.rpd),
      tpd: posOrNull(r.tpd),
    }));

    const overrides = new Map<
      string,
      { rpm: number | null; rpd: number | null; tpd: number | null }
    >();
    for (const r of ovData) {
      overrides.set(`${Number(r.tier_id)}:${r.provider_id}`, {
        rpm: posOrNull(r.rpm),
        rpd: posOrNull(r.rpd),
        tpd: posOrNull(r.tpd),
      });
    }

    const providers = new Map<string, ProviderLimits>();
    for (const r of provData) {
      providers.set(r.id, {
        id: r.id,
        enabled: r.enabled !== false,
        // Default to visible when null (pre-migration column / DB hiccup) so
        // a glitch never silently hides every provider. The real "new
        // providers start hidden" default is enforced by the DB column
        // default, not here.
        visible: r.visible !== false,
        perUserRpm: posOrNull(r.per_user_rpm),
        perUserRpd: posOrNull(r.per_user_rpd),
        perUserTpd: posOrNull(r.per_user_tpd),
        globalRpm: posOrNull(r.global_rpm),
        globalRpd: posOrNull(r.global_rpd),
        globalTpd: posOrNull(r.global_tpd),
      });
    }

    return { tiers, overrides, providers };
  } catch (err) {
    console.error("[limits] config read failed:", (err as Error).message);
    return EMPTY;
  }
}

/** Cached tier/provider config. Never throws (empty config on DB error). */
export async function getLimitConfig(): Promise<LimitConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = await load();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Drop cached config after an admin write so changes apply immediately. */
export function invalidateLimitConfig(): void {
  cache = null;
}

/**
 * Highest-priority tier whose role the user holds; ties → lowest id.
 * null when the user matches no tier.
 */
export function resolveTier(roles: string[], tiers: Tier[]): Tier | null {
  const have = new Set(roles);
  let best: Tier | null = null;
  for (const t of tiers) {
    if (!have.has(t.discordRoleId)) continue;
    if (
      best === null ||
      t.priority > best.priority ||
      (t.priority === best.priority && t.id < best.id)
    ) {
      best = t;
    }
  }
  return best;
}

/**
 * Resolve the three gates' numbers for (user roles, provider). Pure — the
 * caller supplies the cached config and resolved app config.
 */
export function computeLimits(args: {
  roles: string[];
  providerId: string;
  config: LimitConfig;
  app: AppConfig;
}): EffectiveLimits {
  const { roles, providerId, config, app } = args;
  const tier = resolveTier(roles, config.tiers);
  const provider = config.providers.get(providerId);
  const override = tier
    ? config.overrides.get(`${tier.id}:${providerId}`)
    : undefined;

  const overall: Triple = {
    rpm: tier?.rpm ?? app.globalRpm,
    rpd: tier?.rpd ?? app.globalRpd,
    tpd: tier?.tpd ?? app.globalTpd,
  };

  const providerPerUser: NullableTriple = {
    rpm: override?.rpm ?? provider?.perUserRpm ?? null,
    rpd: override?.rpd ?? provider?.perUserRpd ?? null,
    tpd: override?.tpd ?? provider?.perUserTpd ?? null,
  };

  const providerGlobal: NullableTriple = {
    rpm: provider?.globalRpm ?? null,
    rpd: provider?.globalRpd ?? null,
    tpd: provider?.globalTpd ?? null,
  };

  return {
    tier,
    providerEnabled: provider ? provider.enabled : true,
    overall,
    providerPerUser,
    providerGlobal,
  };
}
