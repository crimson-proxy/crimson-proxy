/**
 * Cached Discord roles per user, for tier resolution on the /v1 hot path.
 *
 * Freshness model:
 *   - `users.roles` / `users.roles_updated_at` hold the last known set.
 *   - getUserRoles() refreshes from Discord only when the stored copy is
 *     older than 1h (or never fetched). At most one Discord call per user
 *     per hour on the hot path.
 *   - storeUserRoles() lets paths that ALREADY have fresh roles persist
 *     them for free (Discord slash commands, dashboard login).
 *
 * A short in-memory cache (per warm instance, like lib/bans.ts) avoids
 * hammering the DB for the same user across a burst of requests.
 *
 * Fail-open everywhere: a user with no resolvable roles just gets the
 * global default budget. A Discord/DB error never blocks a request and
 * never wipes known roles — we keep the stale copy and retry on the next
 * window.
 */

import { config } from "./config.js";
import { getDb, hasDb } from "./db.js";
import { getAppConfig } from "./app-config.js";

/** Refresh from Discord when the stored copy is older than this. */
const ROLES_TTL_MS = 60 * 60 * 1000;
/** Per-instance memory cache so a request burst hits the DB once. */
const MEM_TTL_MS = 180_000; // 3 min

type MemEntry = { roles: string[]; expiresAt: number };
const mem = new Map<string, MemEntry>();

function putMem(discordId: string, roles: string[]): void {
  mem.set(discordId, { roles, expiresAt: Date.now() + MEM_TTL_MS });
}

/**
 * Fetch a guild member's role IDs via the bot token. Returns:
 *   - string[]  the member's roles (possibly empty)
 *   - []        the user is not in the guild (Discord 404)
 *   - null      couldn't determine — caller must keep the stale copy
 */
async function fetchDiscordRoles(discordId: string): Promise<string[] | null> {
  const { discordServerId } = await getAppConfig();
  if (!discordServerId || !config.discordBotToken) return null;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${discordServerId}/members/${discordId}`,
      { headers: { Authorization: `Bot ${config.discordBotToken}` } },
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      console.warn(`[user-roles] Discord ${res.status} for ${discordId}`);
      return null;
    }
    const member = (await res.json()) as { roles?: string[] };
    return Array.isArray(member.roles) ? member.roles : [];
  } catch (err) {
    console.error(
      `[user-roles] fetch ${discordId} failed:`,
      (err as Error).message,
    );
    return null;
  }
}

/** Persist roles + bump roles_updated_at. UPDATE-only: never inserts a
 *  half-formed users row (username is NOT NULL), so a missing row is a
 *  no-op rather than an error. */
async function persistRoles(discordId: string, roles: string[]): Promise<void> {
  if (!hasDb()) return;
  try {
    const sql = getDb();
    await sql`
      update users
        set roles = ${roles}::text[],
            roles_updated_at = ${new Date().toISOString()}
      where discord_id = ${discordId}
    `;
  } catch (err) {
    console.error("[user-roles] persist failed:", (err as Error).message);
  }
}

/**
 * Roles for a user, refreshing from Discord if the stored copy is stale.
 * Never throws; returns [] when nothing is resolvable.
 */
export async function getUserRoles(discordId: string): Promise<string[]> {
  if (!discordId) return [];

  const now = Date.now();
  const cached = mem.get(discordId);
  if (cached && cached.expiresAt > now) return cached.roles;

  if (!hasDb()) {
    const live = await fetchDiscordRoles(discordId);
    const roles = live ?? [];
    putMem(discordId, roles);
    return roles;
  }

  let stored: string[] = [];
  let updatedAt: number | null = null;
  try {
    const sql = getDb();
    const rows = await sql<{ roles: string[] | null; roles_updated_at: string | null }[]>`
      select roles, roles_updated_at
      from users
      where discord_id = ${discordId}
      limit 1
    `;
    if (rows[0]) {
      stored = rows[0].roles ?? [];
      updatedAt = rows[0].roles_updated_at
        ? new Date(rows[0].roles_updated_at).getTime()
        : null;
    }
  } catch (err) {
    console.error("[user-roles] read failed:", (err as Error).message);
  }

  const fresh = updatedAt !== null && now - updatedAt < ROLES_TTL_MS;
  if (fresh) {
    putMem(discordId, stored);
    return stored;
  }

  // Stale or never fetched → refresh from Discord. On any failure keep the
  // stale copy (don't wipe) and don't bump the timestamp, so we retry next
  // window instead of pinning empty roles for an hour.
  const live = await fetchDiscordRoles(discordId);
  if (live === null) {
    putMem(discordId, stored);
    return stored;
  }
  await persistRoles(discordId, live);
  putMem(discordId, live);
  return live;
}

/**
 * Persist roles a caller already has fresh (Discord interaction payload /
 * dashboard login). Keeps the hot path from ever needing to fetch.
 */
export async function storeUserRoles(
  discordId: string,
  roles: string[],
): Promise<void> {
  if (!discordId) return;
  putMem(discordId, roles);
  await persistRoles(discordId, roles);
}
