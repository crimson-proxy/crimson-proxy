/**
 * Ban / timeout enforcement.
 *
 * Centralizes every read of the `banned_users` table so we have one
 * consistent definition of "is this user currently banned?" — checking
 * `unbanned_at` and `expires_at` together — and one place that handles
 * lazy expiry of timeouts.
 *
 * ─── Why lazy expiry ───────────────────────────────────────────────────
 * The deployment target is serverless. There is no long-running process
 * to host a sweep job, so expired timeouts can't be cleared on a
 * schedule. Instead, every read here checks `expires_at` against the
 * current time and, if expired, writes `unbanned_at` inline before
 * returning "not banned". The user's next request — whether to the API,
 * dashboard, or Discord — is what clears the row.
 *
 * ─── Caching ───────────────────────────────────────────────────────────
 * `requireApiKey` runs on every /v1/* request, which would mean an extra
 * round-trip to Postgres on every chat completion. We cache lookups in
 * memory for 3 min. The cache is per warm instance and is not a correctness
 * boundary — a cold start re-reads, and admin endpoints call
 * `invalidateBanCache` after ban/timeout/unban writes so changes apply
 * immediately on the instance that handled the write. Other warm
 * instances will see stale data for at most CACHE_TTL_MS, which is an
 * acceptable trade for one DB roundtrip per request.
 */

import { getDb, hasDb } from "./db.js";

export type ActiveBan = {
  /** Always true when this object is returned; null is returned when not banned. */
  banned: true;
  /** ISO timestamp; null means permanent ban. */
  expiresAt: string | null;
  reason: string | null;
};

const CACHE_TTL_MS = 180_000; // 3 min

type CacheEntry = { value: ActiveBan | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/**
 * Check whether a Discord user has an active ban or timeout.
 *
 * Returns the ban details when active, or null when the user is clean
 * (including the case where a previously-active timeout has just
 * expired — that row gets its `unbanned_at` set inline as a side effect).
 *
 * Returns null when the DB isn't configured, matching the rest of the
 * codebase ("if there's no DB, let everything through").
 */
export async function getActiveBan(discordUserId: string): Promise<ActiveBan | null> {
  if (!hasDb() || !discordUserId) return null;

  const now = Date.now();
  const cached = cache.get(discordUserId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const sql = getDb();
  type Row = { id: number; expires_at: string | null; reason: string | null };
  // Fetch the most-recent active row. Order+limit defends against the
  // edge case where a user has more than one active row (e.g. an admin
  // used /timeout on a permanently-banned user, leaving two rows with
  // NULL unbanned_at).
  let rows: Row[];
  try {
    rows = await sql<Row[]>`
      select id, expires_at, reason
      from banned_users
      where discord_id = ${discordUserId}
        and unbanned_at is null
      order by banned_at desc
      limit 1
    `;
  } catch {
    cache.set(discordUserId, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const data = rows[0];
  if (!data) {
    cache.set(discordUserId, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  // Lazy expiry: if the most-recent active row is a timeout that has
  // already passed, clear ALL expired active rows for this user inline.
  if (data.expires_at && new Date(data.expires_at).getTime() < now) {
    const nowIso = new Date().toISOString();
    await sql`
      update banned_users
        set unbanned_at = ${nowIso}
      where discord_id = ${discordUserId}
        and unbanned_at is null
        and expires_at is not null
        and expires_at < ${nowIso}
    `;
    cache.set(discordUserId, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const value: ActiveBan = {
    banned: true,
    expiresAt: data.expires_at,
    reason: data.reason,
  };
  cache.set(discordUserId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Drop a user's cached ban status. Call this from admin endpoints after
 * any write to `banned_users` so the next request sees the new state on
 * this instance immediately instead of waiting up to CACHE_TTL_MS.
 */
export function invalidateBanCache(discordUserId: string): void {
  cache.delete(discordUserId);
}
