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
import { getLimitConfig, computeLimits } from "./limits.js";
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

/** Row count for the filter. null = query errored (caller fails open). */
async function countRows(sql: Sql, f: Filter): Promise<number | null> {
  try {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from request_logs ${whereFor(sql, f)}
    `;
    return Number(count);
  } catch (err) {
    console.error("[usage-limit] count failed:", (err as Error).message);
    return null;
  }
}

/** Sum of total_tokens for the filter. null = errored (fail open). */
async function sumTokens(sql: Sql, f: Filter): Promise<number | null> {
  try {
    const [{ sum }] = await sql<{ sum: number | null }[]>`
      select coalesce(sum(total_tokens), 0)::bigint as sum
      from request_logs ${whereFor(sql, f)}
    `;
    return Number(sum ?? 0);
  } catch (err) {
    console.error("[usage-limit] token sum failed:", (err as Error).message);
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

  // Each entry: a metric+scope with a finite limit to enforce, and the
  // request_logs filter that counts usage against it. Evaluated in order;
  // first violation wins so the user gets the tightest relevant message.
  const checks: Array<{
    metric: LimitMetric;
    scope: LimitScope;
    limit: number;
    base: Filter;
  }> = [];

  const push = (
    metric: LimitMetric,
    scope: LimitScope,
    limit: number | null,
    base: Filter,
  ) => {
    if (limit !== null) checks.push({ metric, scope, limit, base });
  };

  // Gate 1 — overall (this user, any provider that was actually reached).
  push("rpm", "overall", eff.overall.rpm, { since: rpmSince, discordId, requireVia: true });
  push("rpd", "overall", eff.overall.rpd, { since: daySince, discordId, requireVia: true });
  push("tpd", "overall", eff.overall.tpd, { since: daySince, discordId, requireVia: true });

  // Gate 2 — this user, on this provider (only the metrics with a cap).
  push("rpm", "provider", eff.providerPerUser.rpm, { since: rpmSince, discordId, providerId });
  push("rpd", "provider", eff.providerPerUser.rpd, { since: daySince, discordId, providerId });
  push("tpd", "provider", eff.providerPerUser.tpd, { since: daySince, discordId, providerId });

  // Gate 3 — all users combined, on this provider.
  push("rpm", "provider_global", eff.providerGlobal.rpm, { since: rpmSince, providerId });
  push("rpd", "provider_global", eff.providerGlobal.rpd, { since: daySince, providerId });
  push("tpd", "provider_global", eff.providerGlobal.tpd, { since: daySince, providerId });

  for (const ch of checks) {
    const used =
      ch.metric === "tpd"
        ? await sumTokens(sql, ch.base)
        : await countRows(sql, ch.base);

    // Query error → fail open for this check (skip it), don't hard-block.
    if (used === null) continue;
    if (used < ch.limit) continue;

    const retryAfterSeconds =
      ch.metric === "rpm"
        ? await rpmRetryAfter(sql, ch.base, now)
        : secondsUntilNextUtcMidnight(now);

    return {
      allowed: false,
      metric: ch.metric,
      scope: ch.scope,
      limit: ch.limit,
      used,
      retryAfterSeconds,
    };
  }

  return { allowed: true };
}
