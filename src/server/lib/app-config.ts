/**
 * DB-backed operational config, with env as the bootstrap fallback.
 *
 * Non-secret settings that used to be env-only now live in the `app_config`
 * table so they're editable from the admin dashboard without a redeploy:
 *   - discord_server_id
 *   - discord_required_role_id
 *   - discord_admin_role_ids   (comma-separated)
 *   - discord_staff_channel_id
 *   - discord_status_channel_id     (model-health board target)
 *   - discord_status_message_id     (internal — board's discord message id)
 *   - discord_status_last_edit_at   (internal — throttle timestamp, ISO)
 *   - warm_last_run_at              (internal — warmer throttle, ISO)
 *   - prune_last_run_at             (internal — pruner throttle, ISO)
 *   - global_rpm / global_rpd / global_tpd  (default per-user budget)
 *
 * Resolution per key: DB value → env value (config.ts) → hardcoded default
 * (limits only). Env stays as the bootstrap fallback on purpose: dashboard
 * access is itself gated by the server/role ids, so if those only lived in
 * the DB you couldn't reach the UI to set them on a fresh deploy. Secrets
 * (bot token, client secret, signing secret, Supabase keys, provider API
 * keys) are deliberately NOT here — they stay env-only.
 *
 * The two `discord_status_*` internal keys are DB-only — they're machine
 * managed (set when the bot first posts the board, updated on each edit)
 * and have no env counterpart. Same for `warm_last_run_at` and
 * `prune_last_run_at`, which are throttle markers updated by lib/warmer.ts
 * after each successful warm or prune.
 *
 * Cached for 30s like lib/bans.ts: getAppConfig() runs on hot paths
 * (every /v1 request resolves limits through it). The cache is per warm
 * instance and not a correctness boundary — admin writes call
 * invalidateAppConfig() so the editing instance sees changes immediately;
 * other warm instances converge within the TTL.
 *
 * Fail-safe: if Supabase is unreachable or the table errors, we fall back
 * to env + defaults rather than throwing — a DB hiccup must not take down
 * config resolution (and therefore every /v1 request).
 */

import { config } from "./config.js";
import { getDb, hasDb } from "./db.js";

/** Hardcoded final fallback for the per-user global budget. */
export const HARDCODED_GLOBAL_RPM = 5;
export const HARDCODED_GLOBAL_RPD = 200;
export const HARDCODED_GLOBAL_TPD = 5_000_000;

export type AppConfig = {
  discordServerId: string;
  discordRequiredRoleId: string;
  discordAdminRoleIds: string[];
  discordStaffChannelId: string;
  /** Channel where the live model-health board is posted/edited. Blank = feature off. */
  discordStatusChannelId: string;
  /** Discord message id of the board. Empty = first post hasn't happened yet. */
  discordStatusMessageId: string;
  /** ISO timestamp of the last successful edit. Empty = never edited. */
  discordStatusLastEditAt: string;
  /** ISO timestamp of the last successful warmer tick. Empty = never run. */
  warmLastRunAt: string;
  /** ISO timestamp of the last successful pruner tick. Empty = never run. */
  pruneLastRunAt: string;
  /** Per-user global default budget. Always a positive integer. */
  globalRpm: number;
  globalRpd: number;
  globalTpd: number;
};

const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: AppConfig; expiresAt: number };
let cache: CacheEntry | null = null;

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a positive integer; fall back when missing / non-numeric / <= 0. */
function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read every app_config row into a key→value map. Empty on any failure. */
async function readConfigRows(): Promise<Record<string, string>> {
  if (!hasDb()) return {};
  try {
    const sql = getDb();
    const rows = await sql<{ key: string; value: string | null }[]>`
      select key, value from app_config
    `;
    const map: Record<string, string> = {};
    for (const row of rows) {
      if (row.value !== null && row.value !== "") map[row.key] = row.value;
    }
    return map;
  } catch (err) {
    console.error("[app-config] read failed:", (err as Error).message);
    return {};
  }
}

function resolve(db: Record<string, string>): AppConfig {
  // DB value wins; otherwise the value config.ts already read from env.
  const adminRaw = db.discord_admin_role_ids;
  return {
    discordServerId: db.discord_server_id ?? config.discordServerId,
    discordRequiredRoleId:
      db.discord_required_role_id ?? config.discordRequiredRoleId,
    discordAdminRoleIds:
      adminRaw !== undefined ? parseCsv(adminRaw) : config.discordAdminRoleIds,
    discordStaffChannelId:
      db.discord_staff_channel_id ?? config.discordStaffChannelId,
    // DB-only — no env counterpart. Set via /admin → Limits & Config →
    // Global. Empty string when unset (= feature disabled).
    discordStatusChannelId: db.discord_status_channel_id ?? "",
    // DB-only — no env fallback. Empty string when unset.
    discordStatusMessageId: db.discord_status_message_id ?? "",
    discordStatusLastEditAt: db.discord_status_last_edit_at ?? "",
    warmLastRunAt: db.warm_last_run_at ?? "",
    pruneLastRunAt: db.prune_last_run_at ?? "",
    globalRpm: parseLimit(db.global_rpm, HARDCODED_GLOBAL_RPM),
    globalRpd: parseLimit(db.global_rpd, HARDCODED_GLOBAL_RPD),
    globalTpd: parseLimit(db.global_tpd, HARDCODED_GLOBAL_TPD),
  };
}

/**
 * Resolved operational config (DB → env → default). Cached 30s per warm
 * instance. Never throws — falls back to env + defaults on any DB error.
 */
export async function getAppConfig(): Promise<AppConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const value = resolve(await readConfigRows());
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/**
 * Drop the cached config. Call from admin endpoints after any write to
 * app_config so the editing instance reflects the change immediately
 * instead of waiting out the TTL.
 */
export function invalidateAppConfig(): void {
  cache = null;
}

/**
 * Upsert one app_config row and invalidate the local cache.
 *
 * Used by lib/discord-status.ts to persist the board's machine-managed
 * fields (message id, last edit timestamp) — admins use the bulk
 * /api/admin/config PUT for the human-facing keys instead.
 *
 * Fail-safe: a write failure is logged and swallowed. The board logic
 * treats every refresh as best-effort, so a transient DB hiccup just
 * means the next chat request retries.
 */
export async function setAppConfigKey(
  key: string,
  value: string,
): Promise<void> {
  if (!hasDb()) return;
  try {
    const sql = getDb();
    await sql`
      insert into app_config (key, value) values (${key}, ${value})
      on conflict (key) do update set value = excluded.value
    `;
    invalidateAppConfig();
  } catch (err) {
    console.error(
      `[app-config] upsert ${key} failed:`,
      (err as Error).message,
    );
  }
}

/**
 * Atomically claim a throttle window backed by an app_config timestamp key.
 * Returns true iff THIS caller won — i.e. the stored timestamp was empty or
 * older than `windowMs`, and we just advanced it to now.
 *
 * This is the cross-instance lock the Discord status board needs. The
 * board's refresh fires fire-and-forget after every chat request, so many
 * Cloudflare isolates (and the Vercel mirror) run it at once. The app_config
 * row is the ONLY state they share, so this single conditional UPDATE is
 * what actually serializes them: Postgres row-locks the row, so exactly one
 * caller's UPDATE succeeds per window and the rest get zero rows back. The
 * previous approach (read a 30s per-isolate cache, write the timestamp at
 * the END of the refresh) let several isolates pass the check together and
 * churn the board — posting and purging messages instead of editing them.
 *
 * Stored values are ISO-8601 UTC strings from toISOString(), so a plain
 * string comparison is also a chronological one — no `::timestamptz` cast
 * that could throw on a malformed value.
 *
 * No DB configured (local dev, single process) → proceed (true): there's no
 * concurrency to guard. DB configured but erroring → don't proceed (false):
 * if we can't coordinate, skip this tick rather than risk the churn; the
 * next chat request retries.
 */
export async function claimThrottleWindow(
  key: string,
  windowMs: number,
): Promise<boolean> {
  if (!hasDb()) return true;
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();
  try {
    const sql = getDb();
    const rows = await sql<{ key: string }[]>`
      insert into app_config (key, value) values (${key}, ${nowIso})
      on conflict (key) do update set value = excluded.value
        where app_config.value = '' or app_config.value < ${cutoffIso}
      returning key
    `;
    if (rows.length > 0) {
      invalidateAppConfig();
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[app-config] claim ${key} failed:`, (err as Error).message);
    return false;
  }
}
