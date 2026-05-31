/**
 * Users store.
 *
 * Stores Discord profile info (id, username, avatar hash) in Postgres.
 * Upserted on every Discord OAuth login so display names and avatars
 * stay fresh. Any feature that needs to display user info queries this
 * table instead of making live Discord API calls.
 */

import { config } from "./config.js";
import { getDb, hasDb } from "./db.js";

export type StoredUser = {
  discordId: string;
  username: string;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Insert or update a user's profile. Called on every Discord OAuth login.
 */
export async function upsertUser(profile: {
  discordId: string;
  username: string;
  avatar: string | null;
}): Promise<void> {
  if (!hasDb()) return;
  const sql = getDb();
  try {
    await sql`
      insert into users (discord_id, username, avatar, updated_at)
      values (${profile.discordId}, ${profile.username}, ${profile.avatar ?? null}, ${new Date().toISOString()})
      on conflict (discord_id) do update
        set username = excluded.username,
            avatar = excluded.avatar,
            updated_at = excluded.updated_at
    `;
  } catch (err) {
    console.error("[users] upsert failed:", (err as Error).message);
  }
}

type UserRow = {
  discord_id: string;
  username: string;
  avatar: string | null;
  created_at: string;
  updated_at: string;
};

function rowToUser(row: UserRow): StoredUser {
  return {
    discordId: row.discord_id,
    username: row.username,
    avatar: row.avatar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Fetch a single user by Discord ID.
 */
export async function getUser(discordId: string): Promise<StoredUser | null> {
  if (!hasDb()) return null;
  const sql = getDb();
  try {
    const rows = await sql<UserRow[]>`
      select discord_id, username, avatar, created_at, updated_at
      from users
      where discord_id = ${discordId}
      limit 1
    `;
    return rows[0] ? rowToUser(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch multiple users by Discord IDs. Returns a map of id → user.
 * Missing users are silently omitted.
 */
export async function getUsersByIds(
  ids: string[],
): Promise<Record<string, StoredUser>> {
  if (!hasDb() || ids.length === 0) return {};
  const sql = getDb();
  let rows: UserRow[];
  try {
    rows = await sql<UserRow[]>`
      select discord_id, username, avatar, created_at, updated_at
      from users
      where discord_id in ${sql(ids)}
    `;
  } catch {
    return {};
  }

  const map: Record<string, StoredUser> = {};
  for (const row of rows) {
    const user = rowToUser(row);
    map[user.discordId] = user;
  }
  return map;
}

/**
 * Make sure the `users` table has a row for this Discord ID.
 *
 * Used by admin endpoints that target another user (ban / timeout / unban /
 * key revoke). Those write the target's ID into `banned_users` or
 * `action_logs`, and the admin UI later joins those tables to `users` to
 * render the username and avatar. If the target has never logged in via
 * the dashboard or run a slash command themselves, their row won't exist
 * and the UI shows a raw ID instead of a name. This helper closes that gap.
 *
 * Errors are logged and swallowed. The admin action must NOT fail just
 * because resolving a username didn't work (e.g. user left Discord, bot
 * token misconfigured, network blip).
 */
export async function ensureUserExists(discordId: string): Promise<void> {
  if (!hasDb() || !discordId) return;
  if (!config.discordBotToken) return;

  const sql = getDb();
  try {
    const existing = await sql<{ discord_id: string }[]>`
      select discord_id from users where discord_id = ${discordId} limit 1
    `;
    if (existing[0]) return;
  } catch {
    return;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
      headers: { Authorization: `Bot ${config.discordBotToken}` },
    });
    if (!res.ok) {
      console.warn(`[users] ensureUserExists ${discordId}: Discord ${res.status}`);
      return;
    }
    const u = (await res.json()) as { id: string; username: string; global_name?: string | null; avatar: string | null };
    await upsertUser({
      discordId: u.id,
      username: u.global_name ?? u.username,
      avatar: u.avatar ?? null,
    });
  } catch (err) {
    console.error(`[users] ensureUserExists ${discordId} failed:`, (err as Error).message);
  }
}
