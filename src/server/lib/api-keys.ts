/**
 * API key management.
 *
 * Keys are stored as SHA-256 hashes. The plaintext key exists only at
 * creation time, when we return it to the caller (the Discord route DMs
 * it to the user). After that we never see the plaintext again, so even
 * a database leak doesn't expose working keys.
 *
 * Schema lives in scripts/migrate.ts (api_keys, action_logs).
 */

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";

export type ApiKeyRecord = {
  id: number;
  keyPreview: string | null;
  discordUserId: string;
  discordUsername: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  notes: string | null;
};

/** Hash a plaintext key the same way we'll hash incoming bearer tokens. */
function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generate a fresh API key. Prefixed with 'crp_' so users (and us) can
 * recognize them at a glance, followed by 32 bytes of base64url randomness.
 */
function generateKey(): string {
  return `crp_${randomBytes(32).toString("base64url")}`;
}

/**
 * Create a new key for a Discord user. Returns the PLAINTEXT key (the
 * caller must hand this to the user immediately; we never store it).
 */
export async function createKey(
  discordUserId: string,
  discordUsername: string,
  notes?: string,
): Promise<{ key: string; id: number }> {
  const key = generateKey();
  const keyHash = hashKey(key);
  const keyPreview = key.slice(0, 8) + "..." + key.slice(-4);

  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    insert into api_keys
      (key_hash, key_preview, discord_user_id, discord_username, notes)
    values
      (${keyHash}, ${keyPreview}, ${discordUserId}, ${discordUsername}, ${notes ?? null})
    returning id
  `;
  if (!row) throw new Error("failed to create api key");

  await sql`
    insert into action_logs (actor_id, action, target_id, reason, metadata)
    values (
      ${discordUserId},
      ${notes === "regenerated" ? "REGENERATE_KEY" : "CREATE_KEY"},
      ${discordUserId},
      ${notes ?? "Requested via Discord"},
      ${sql.json({ key_id: row.id })}
    )
  `;

  return { key, id: row.id };
}

/**
 * Revoke a specific key by id. Sets revoked_at; doesn't delete the row so
 * audit history stays intact.
 */
export async function revokeKey(id: number): Promise<void> {
  const sql = getDb();
  await sql`update api_keys set revoked_at = ${new Date().toISOString()} where id = ${id}`;
}

/** Revoke every active key for a Discord user. Used by /regenerate-api-key. */
export async function revokeAllForUser(discordUserId: string, actorId?: string): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ id: number }[]>`
    update api_keys
      set revoked_at = ${new Date().toISOString()}
    where discord_user_id = ${discordUserId}
      and revoked_at is null
    returning id
  `;

  if (rows.length > 0) {
    await sql`
      insert into action_logs (actor_id, action, target_id, reason)
      values (
        ${actorId || discordUserId},
        ${"REVOKE_KEY"},
        ${discordUserId},
        ${`Bulk revoked ${rows.length} key(s)`}
      )
    `;
  }

  return rows.length;
}

/** List all (active + revoked) keys for a Discord user. */
export async function listKeysForUser(discordUserId: string): Promise<ApiKeyRecord[]> {
  const sql = getDb();
  type Row = {
    id: number;
    key_preview: string | null;
    discord_user_id: string;
    discord_username: string | null;
    created_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
    notes: string | null;
  };
  const rows = await sql<Row[]>`
    select id, key_preview, discord_user_id, discord_username,
           created_at, revoked_at, last_used_at, notes
    from api_keys
    where discord_user_id = ${discordUserId}
    order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    keyPreview: row.key_preview,
    discordUserId: row.discord_user_id,
    discordUsername: row.discord_username,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    notes: row.notes,
  }));
}

/**
 * Look up a plaintext key for auth. Returns the owning user info, or null
 * if the key is unknown or revoked. Also bumps last_used_at as a side
 * effect (fire-and-forget; not awaited so we don't add latency).
 */
export async function lookupKey(
  plaintext: string,
): Promise<{ id: number; discordUserId: string; discordUsername: string | null } | null> {
  if (!plaintext) return null;
  const keyHash = hashKey(plaintext);

  const sql = getDb();
  type Row = {
    id: number;
    discord_user_id: string;
    discord_username: string | null;
    revoked_at: string | null;
  };
  // Let DB errors propagate — callers must distinguish "key not found"
  // (null) from "DB unreachable" (thrown) so they can return 503 instead
  // of a misleading 401 "invalid key" when the database is down.
  const rows = await sql<Row[]>`
    select id, discord_user_id, discord_username, revoked_at
    from api_keys
    where key_hash = ${keyHash}
    limit 1
  `;

  const data = rows[0];
  if (!data || data.revoked_at) return null;

  // Fire-and-forget last_used_at bump.
  sql`
    update api_keys set last_used_at = ${new Date().toISOString()} where id = ${data.id}
  `.catch((e: Error) => {
    console.error("[api-keys] last_used_at update failed:", e.message);
  });

  return {
    id: data.id,
    discordUserId: data.discord_user_id,
    discordUsername: data.discord_username,
  };
}
