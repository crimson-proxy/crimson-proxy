/**
 * Unified per-user usage limiter.
 *
 * READ-ONLY: every count/sum is derived from `request_logs` — there is no
 * separate counter table and this module never writes. One row already
 * exists per request (written by routes/chat.ts appendLog). We deliberately
 * accept that a parallel burst can slip a few requests past RPM before
 * their rows land: this proxy serves regular RP users, not adversaries
 * crafting concurrent floods, and the simplicity is worth it.
 *
 * Only rows that actually reached a provider are counted: the filters
 * require `via` (the provider id) — set on success AND upstream-error rows
 * but NULL on self-inflicted 429s and bad-model-name routing errors, so
 * those don't count against the user (and a blocked user can't dig their
 * own hole deeper by retrying).
 *
 * Three gates, all must pass (numbers resolved by lib/limits.ts):
 *   1. overall          — this user, across ALL providers
 *   2. provider/per-user — this user, on THIS provider (optional)
 *   3. provider/global   — ALL users, on THIS provider (optional)
 * Per metric: RPM = rows in the last 60s, RPD = rows since 00:00 UTC,
 * TPD = sum(total_tokens) since 00:00 UTC.
 *
 * Fail-open, like lib/bans.ts: if the DB is down or a query errors, that
 * check is skipped (request allowed) rather than hard-blocking everyone.
 *
 * Ban/timeout is NOT handled here — middleware/auth.ts enforces it on
 * every /v1 request before this runs.
 */

import { getDb, hasDb } from "./db.js";
import { getAppConfig } from "./app-config.js";
import { getLimitConfig, computeLimits, type NullableTriple } from "./limits.js";
import { getUserRoles } from "./user-roles.js";

export type LimitMetric = "rpm" | "rpd" | "tpd";
export type LimitScope = "overall" | "provider" | "provider_global";

export type UsageResult =
  | { allowed: true }
  | {
      allowed: false;
      metric: LimitMetric;
      scope: LimitScope;
      limit: number;
      used: number;
      retryAfterSeconds: number;
    };

const RPM_WINDOW_SECONDS = 60;

function startOfUtcDay(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function secondsUntilNextUtcMidnight(now: number): number {
  const next = startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

type Filter = {
  since: string;
  /** Scope to one user (Gates 1 & 2). Omit for the all-users Gate 3. */
  discordId?: string;
  /** Scope to one provider via `via=P` (Gates 2 & 3). */
  providerId?: string;
  /** Gate 1 only: count any row that reached *a* provider (via not null). */
  requireVia?: boolean;
};

type Sql = ReturnType<typeof getDb>;

/** Build the WHERE-clause fragment for a Filter using sql template tags. */
function whereFor(sql: Sql, f: Filter) {
  // Compose conjunctions with sql template fragments. Each conditional
  // returns either a fragment or an "always true" placeholder so the
  // composed AND chain is structurally identical regardless of which
  // optional filters apply.
  const userCond = f.discordId
    ? sql`and discord_user_id = ${f.discordId}`
    : sql``;
  const providerCond = f.providerId
    ? sql`and via = ${f.providerId}`
    : f.requireVia
      ? sql`and via is not null`
      : sql``;
  return sql`where created_at >= ${f.since} ${userCond} ${providerCond}`;
}

/** rpm + rpd + tpd for one scope's filter, in a single round-trip. */
type ScopeUsage = { rpm: number; rpd: number; tpd: number };

/**
 * Fold a scope's three metrics into ONE query.
 *
 * rpd and tpd share the day window; rpm's 60s window is (almost always) a
 * subset of it. So a single scan, floored at the EARLIER of the two
 * boundaries, with a per-metric FILTER on each aggregate, replaces what used
 * to be three separate round-trips (count, count, sum). The floor is
 * `least(rpmSince, daySince)` so the ~60s right after UTC midnight — when the
 * rpm window reaches back across midnight — still counts the full last minute
 * for rpm, while the daySince FILTER keeps those pre-midnight rows out of
 * rpd/tpd.
 *
 * null = the query errored; the caller fails open (skips this scope) exactly
 * as the old per-metric path did.
 */
async function scopeUsage(
  sql: Sql,
  base: Pick<Filter, "discordId" | "providerId" | "requireVia">,
  rpmSince: string,
  daySince: string,
): Promise<ScopeUsage | null> {
  const userCond = base.discordId
    ? sql`and discord_user_id = ${base.discordId}`
    : sql``;
  const providerCond = base.providerId
    ? sql`and via = ${base.providerId}`
    : base.requireVia
      ? sql`and via is not null`
      : sql``;
  // ISO-8601 UTC strings compare chronologically as plain strings.
  const floorSince = rpmSince < daySince ? rpmSince : daySince;
  try {
    const [row] = await sql<{ rpm: string; rpd: string; tpd: string }[]>`
      select
        (count(*) filter (where created_at >= ${rpmSince}))::int as rpm,
        (count(*) filter (where created_at >= ${daySince}))::int as rpd,
        coalesce(sum(total_tokens) filter (where created_at >= ${daySince}), 0)::bigint as tpd
      from request_logs
      where created_at >= ${floorSince} ${userCond} ${providerCond}
    `;
    return { rpm: Number(row.rpm), rpd: Number(row.rpd), tpd: Number(row.tpd) };
  } catch (err) {
    console.error("[usage-limit] scope usage query failed:", (err as Error).message);
    return null;
  }
}

/** Seconds until the oldest hit in the RPM window ages out. */
async function rpmRetryAfter(
  sql: Sql,
  f: Filter,
  now: number,
): Promise<number> {
  try {
    const rows = await sql<{ created_at: string }[]>`
      select created_at from request_logs ${whereFor(sql, f)}
      order by created_at asc limit 1
    `;
    const oldest = rows[0]?.created_at;
    if (!oldest) return RPM_WINDOW_SECONDS;
    return Math.max(
      1,
      Math.ceil(
        (new Date(oldest).getTime() + RPM_WINDOW_SECONDS * 1000 - now) / 1000,
      ),
    );
  } catch {
    return RPM_WINDOW_SECONDS;
  }
}

/**
 * Decide whether `discordId` may make one more request to `providerId`.
 * Never throws; fail-open on any DB error.
 */
export async function checkUsage(
  discordId: string,
  providerId: string,
): Promise<UsageResult> {
  if (!hasDb()) return { allowed: true };
  const sql = getDb();

  const now = Date.now();
  const rpmSince = new Date(now - RPM_WINDOW_SECONDS * 1000).toISOString();
  const daySince = startOfUtcDay(now).toISOString();

  const roles = await getUserRoles(discordId);
  const [cfg, app] = await Promise.all([getLimitConfig(), getAppConfig()]);
  const eff = computeLimits({ roles, providerId, config: cfg, app });

  // One scope = one query (rpm+rpd+tpd folded via FILTER), run only when
  // that scope actually has a finite limit to enforce. Scopes are evaluated
  // in priority order — overall, then provider-per-user, then
  // provider-global — and within a scope rpm → rpd → tpd, so the first
  // violation returns the tightest relevant message, exactly as the old
  // per-check loop did. Common case (only the overall defaults apply) is a
  // single query; all gates configured is three.
  const gates: Array<{
    scope: LimitScope;
    base: Pick<Filter, "discordId" | "providerId" | "requireVia">;
    limits: NullableTriple;
  }> = [
    // Gate 1 — overall (this user, any provider that was actually reached).
    {
      scope: "overall",
      base: { discordId, requireVia: true },
      limits: { rpm: eff.overall.rpm, rpd: eff.overall.rpd, tpd: eff.overall.tpd },
    },
    // Gate 2 — this user, on this provider.
    { scope: "provider", base: { discordId, providerId }, limits: eff.providerPerUser },
    // Gate 3 — all users combined, on this provider.
    { scope: "provider_global", base: { providerId }, limits: eff.providerGlobal },
  ];

  for (const { scope, base, limits } of gates) {
    // Nothing to enforce on this scope → no query at all (the common case
    // for the provider scopes when no per-provider caps are configured).
    if (limits.rpm === null && limits.rpd === null && limits.tpd === null) continue;

    const usage = await scopeUsage(sql, base, rpmSince, daySince);
    // Query error → fail open for the whole scope, same posture as the old
    // per-check `used === null` skip.
    if (usage === null) continue;

    const metrics: Array<{ metric: LimitMetric; limit: number | null; used: number }> = [
      { metric: "rpm", limit: limits.rpm, used: usage.rpm },
      { metric: "rpd", limit: limits.rpd, used: usage.rpd },
      { metric: "tpd", limit: limits.tpd, used: usage.tpd },
    ];

    for (const { metric, limit, used } of metrics) {
      if (limit === null || used < limit) continue;

      const retryAfterSeconds =
        metric === "rpm"
          ? await rpmRetryAfter(sql, { since: rpmSince, ...base }, now)
          : secondsUntilNextUtcMidnight(now);

      return { allowed: false, metric, scope, limit, used, retryAfterSeconds };
    }
  }

  return { allowed: true };
}
