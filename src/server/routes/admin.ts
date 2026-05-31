import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { config } from "../lib/config.js";
import { getAppConfig } from "../lib/app-config.js";
import { getUsersByIds, ensureUserExists } from "../lib/users.js";
import { storeUserRoles } from "../lib/user-roles.js";
import { getDb } from "../lib/db.js";
import { revokeKey, revokeAllForUser } from "../lib/api-keys.js";
import { invalidateBanCache } from "../lib/bans.js";
import { invalidateAppConfig } from "../lib/app-config.js";
import { invalidateLimitConfig } from "../lib/limits.js";
import { invalidateProviderRegistry } from "../providers/registry.js";
import { fetchUpstreamModels, type ProviderConfig } from "../providers/dynamic.js";

const TOKEN_TTL_SECONDS = 10 * 60;

const admin = new Hono();

const signingKey = new TextEncoder().encode(config.adminSigningSecret);

/**
 * Length-cap and strip SQL/ILIKE metacharacters from a free-text search
 * before splicing into an ILIKE pattern. `%` and `_` are wildcards;
 * `\` is the escape; long runs of `%` enable catastrophic backtracking
 * on big tables. Discord IDs are 17-19 digits and usernames are <= 32
 * chars, so 64 is generous. Returns "" for inputs that become empty
 * after stripping — callers should skip the filter when this returns "".
 *
 * Note: `.` and `_` … wait — `_` is a wildcard in LIKE so it's dropped
 * here too. Real usernames may contain `_` but we accept that the search
 * can't match `_` literally; the value still narrows the result.
 */
function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()%_*\\]/g, "").trim().slice(0, 64);
}

/** Verify a Discord session JWT and return the embedded identity. */
async function extractSessionUser(
  sessionToken: string,
): Promise<{ id: string; username: string } | null> {
  try {
    const { payload } = await jwtVerify(sessionToken, signingKey, {
      algorithms: ["HS256"],
    });
    if (payload.type !== "session" || !payload.sub) return null;
    return { id: payload.sub, username: (payload.username as string) ?? "" };
  } catch {
    return null;
  }
}

type AdminPayload = { role: "admin"; discordId: string; discordUsername: string };

async function issueToken(
  discordId: string,
  discordUsername: string,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;

  const token = await new SignJWT({
    role: "admin",
    discordId,
    discordUsername,
  } satisfies AdminPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(signingKey);

  return { token, expiresAt: exp };
}

/** Verify an admin JWT. Returns the embedded identity or null. */
export async function verifyAdminToken(
  token: string,
): Promise<AdminPayload | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey, {
      algorithms: ["HS256"],
    });
    if (payload.role !== "admin") return null;
    return {
      role: "admin",
      discordId: (payload.discordId as string) ?? "",
      discordUsername: (payload.discordUsername as string) ?? "",
    };
  } catch {
    return null;
  }
}

async function requireAdmin(
  c: Parameters<Parameters<typeof admin.use>[1]>[0],
  next: () => Promise<void>,
): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return c.json({ error: "Bad Authorization header" }, 401);
  }
  const admin = await verifyAdminToken(match[1].trim());
  if (!admin) {
    return c.json({ error: "Invalid or expired admin token" }, 401);
  }
  c.set("adminUser" as never, admin as never);
  return next();
}

admin.post("/api/admin/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionToken?: string;
  };

  if (!body.sessionToken) {
    return c.json({ error: "Discord login required" }, 401);
  }

  const user = await extractSessionUser(body.sessionToken);
  if (!user) {
    return c.json({ error: "Invalid or expired Discord session" }, 401);
  }

  const ac = await getAppConfig();
  if (!ac.discordServerId || !config.discordBotToken) {
    return c.json({ error: "Discord integration not configured" }, 503);
  }

  const memberRes = await fetch(
    `https://discord.com/api/guilds/${ac.discordServerId}/members/${user.id}`,
    { headers: { Authorization: `Bot ${config.discordBotToken}` } },
  );

  if (!memberRes.ok) {
    return c.json({ error: "Not a member of the Discord server" }, 403);
  }

  const member = (await memberRes.json()) as { roles: string[] };

  storeUserRoles(user.id, member.roles ?? []).catch(() => {});

  const hasAdminRole = ac.discordAdminRoleIds.some((roleId) =>
    member.roles.includes(roleId),
  );

  if (!hasAdminRole) {
    return c.json({ error: "You don't have admin access" }, 403);
  }

  const { token, expiresAt } = await issueToken(user.id, user.username);
  return c.json({ token, expiresAt, user });
});

admin.get("/api/admin/me", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  return c.json({
    discordId: adminUser.discordId,
    discordUsername: adminUser.discordUsername,
  });
});

admin.get("/api/admin/overview", requireAdmin, async (c) => {
  const sql = getDb();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [
      [{ count: requestsToday }],
      [{ count: errorsToday }],
      [tokens],
    ] = await Promise.all([
      sql<{ count: number }[]>`
        select count(*)::int as count from request_logs
        where created_at >= ${yesterday}
      `,
      sql<{ count: number }[]>`
        select count(*)::int as count from request_logs
        where created_at >= ${yesterday} and status >= 400
      `,
      sql<{ prompt: number; completion: number; total: number }[]>`
        select coalesce(sum(prompt_tokens), 0)::bigint as prompt,
               coalesce(sum(completion_tokens), 0)::bigint as completion,
               coalesce(sum(total_tokens), 0)::bigint as total
        from request_logs
        where created_at >= ${yesterday}
      `,
    ]);

    return c.json({
      requestsToday: Number(requestsToday ?? 0),
      errorsToday: Number(errorsToday ?? 0),
      promptTokensToday: Number(tokens.prompt ?? 0),
      completionTokensToday: Number(tokens.completion ?? 0),
      totalTokensToday: Number(tokens.total ?? 0),
    });
  } catch (err) {
    console.error("[admin] overview failed:", (err as Error).message);
    return c.json({ error: "Failed to load overview stats" }, 500);
  }
});

admin.get("/api/admin/users/stats", requireAdmin, async (c) => {
  const search = c.req.query("search") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const sortBy = c.req.query("sortBy") || "total_requests";

  const sql = getDb();
  let userStats: Array<Record<string, unknown>> = [];
  let bannedData: Array<{ discord_id: string; expires_at: string | null }> = [];
  try {
    [userStats, bannedData] = await Promise.all([
      sql<Array<Record<string, unknown>>>`select * from get_user_stats(${search})`,
      sql<{ discord_id: string; expires_at: string | null }[]>`
        select discord_id, expires_at from banned_users where unbanned_at is null
      `,
    ]);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }

  const now = new Date().getTime();
  type BanState = { type: "ban" | "timeout"; expiresAt: string | null };
  const stateByUser = new Map<string, BanState>();
  for (const row of bannedData) {
    const exp = row.expires_at;
    if (exp && new Date(exp).getTime() <= now) continue;
    const id = row.discord_id;
    const existing = stateByUser.get(id);
    if (existing?.type === "ban") continue;
    stateByUser.set(id, { type: exp ? "timeout" : "ban", expiresAt: exp });
  }

  const sorted = userStats.sort((a: any, b: any) => {
    if (sortBy === "error_requests") {
      return (Number(b.error_requests) || 0) - (Number(a.error_requests) || 0);
    } else if (sortBy === "total_tokens") {
      return (Number(b.total_tokens) || 0) - (Number(a.total_tokens) || 0);
    } else if (sortBy === "last_request") {
      const aTime = a.last_request ? new Date(a.last_request).getTime() : 0;
      const bTime = b.last_request ? new Date(b.last_request).getTime() : 0;
      return bTime - aTime;
    } else {
      return (Number(b.total_requests) || 0) - (Number(a.total_requests) || 0);
    }
  }).map((u: any) => {
    const state = stateByUser.get(u.discord_id);
    return {
      ...u,
      is_banned: !!state,
      ban_type: state?.type ?? null,
      ban_expires_at: state?.expiresAt ?? null,
    };
  });

  const totalCount = sorted.length;
  const start = (page - 1) * limit;
  const paginated = sorted.slice(start, start + limit);

  return c.json({ users: paginated, totalCount });
});

admin.get("/api/admin/logs", requireAdmin, async (c) => {
  const search = c.req.query("search") || "";
  const statusFilter = c.req.query("status") || "all";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const offset = (page - 1) * limit;

  const sql = getDb();
  const safeSearch = sanitizeSearch(search);
  const searchPat = `%${safeSearch}%`;

  // Compose WHERE fragments so the count + paged select share the same
  // filter set. Empty fragments evaluate to no-op AND chains.
  const searchCond = safeSearch
    ? sql`and (discord_username ilike ${searchPat} or discord_user_id ilike ${searchPat})`
    : sql``;
  const statusCond =
    statusFilter === "success"
      ? sql`and status < 400`
      : statusFilter === "error"
        ? sql`and status >= 400`
        : sql``;

  try {
    const [data, [{ count }]] = await Promise.all([
      sql<Array<Record<string, unknown>>>`
        select rl.*, p.prefix as provider_prefix
        from request_logs rl
        left join providers p on p.id = rl.via
        where 1 = 1 ${searchCond} ${statusCond}
        order by rl.created_at desc
        limit ${limit} offset ${offset}
      `,
      sql<{ count: number }[]>`
        select count(*)::int as count from request_logs
        where 1 = 1 ${searchCond} ${statusCond}
      `,
    ]);

    const userIds = Array.from(
      new Set(
        data
          .map((r) => r.discord_user_id as string | null)
          .filter((v): v is string => Boolean(v)),
      ),
    );
    const usersMap = await getUsersByIds(userIds);

    const logs = data.map((r) => ({
      ...r,
      avatar: r.discord_user_id
        ? usersMap[r.discord_user_id as string]?.avatar || null
        : null,
    }));

    return c.json({ logs, totalCount: Number(count) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.get("/api/admin/chart", requireAdmin, async (c) => {
  const sql = getDb();
  const HOUR_MS = 60 * 60 * 1000;
  const nowHour = new Date();
  nowHour.setUTCMinutes(0, 0, 0);
  const oldestBucket = new Date(nowHour.getTime() - 23 * HOUR_MS);
  const nextHour = new Date(nowHour.getTime() + HOUR_MS);

  try {
    const rows = await sql<{ created_at: string; status: number }[]>`
      select created_at, status
      from request_logs
      where created_at >= ${oldestBucket.toISOString()}
        and created_at < ${nextHour.toISOString()}
      order by created_at asc
    `;

    const hoursMap = new Map<
      number,
      { bucketStart: string; requests: number; errors: number }
    >();
    for (let i = 23; i >= 0; i--) {
      const d = new Date(nowHour.getTime() - i * HOUR_MS);
      const key = d.getTime();
      hoursMap.set(key, {
        bucketStart: d.toISOString(),
        requests: 0,
        errors: 0,
      });
    }

    for (const row of rows) {
      const d = new Date(row.created_at);
      d.setUTCMinutes(0, 0, 0);
      const key = d.getTime();
      const entry = hoursMap.get(key);
      if (!entry) continue;
      entry.requests++;
      if (row.status >= 400) entry.errors++;
    }

    return c.json({ chartData: Array.from(hoursMap.values()) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.get("/api/admin/keys", requireAdmin, async (c) => {
  const sql = getDb();
  const search = (c.req.query("search") || "").trim().toLowerCase();
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = (page - 1) * limit;

  const safeSearch = sanitizeSearch(search);
  const searchPat = `%${safeSearch}%`;
  const searchCond = safeSearch
    ? sql`and (discord_username ilike ${searchPat} or discord_user_id ilike ${searchPat})`
    : sql``;

  try {
    const [data, [{ count }]] = await Promise.all([
      sql<Array<Record<string, unknown>>>`
        select id, key_preview, discord_user_id, discord_username,
               created_at, revoked_at, last_used_at, notes
        from api_keys
        where revoked_at is null ${searchCond}
        order by created_at desc
        limit ${limit} offset ${offset}
      `,
      sql<{ count: number }[]>`
        select count(*)::int as count from api_keys
        where revoked_at is null ${searchCond}
      `,
    ]);

    const userIds = Array.from(
      new Set(data.map((r) => r.discord_user_id as string)),
    );
    const usersMap = await getUsersByIds(userIds);

    const keys = data.map((r) => ({
      ...r,
      avatar: usersMap[r.discord_user_id as string]?.avatar || null,
    }));

    return c.json({ keys, totalCount: Number(count) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/api/admin/keys/:id/revoke", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);

  try {
    const { reason } = await c.req.json().catch(() => ({ reason: "No reason provided" }));
    const sql = getDb();
    const [keyData] = await sql<{ discord_user_id: string | null }[]>`
      select discord_user_id from api_keys where id = ${id} limit 1
    `;
    await revokeKey(id);
    if (keyData?.discord_user_id) {
      await ensureUserExists(keyData.discord_user_id);
    }
    await sql`
      insert into action_logs (actor_id, action, target_id, reason, metadata)
      values (
        ${adminUser.discordId},
        ${"REVOKE_KEY"},
        ${keyData?.discord_user_id ?? adminUser.discordId},
        ${reason},
        ${sql.json({ key_id: id })}
      )
    `;
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/api/admin/users/:id/ban", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const discord_id = c.req.param("id");
  const { reason } = await c.req.json().catch(() => ({ reason: "No reason provided" }));
  await ensureUserExists(discord_id);
  const sql = getDb();
  try {
    await sql`
      insert into banned_users (discord_id, reason, banned_at)
      values (${discord_id}, ${reason}, ${new Date().toISOString()})
    `;
    await sql`
      insert into action_logs (actor_id, action, target_id, reason)
      values (${adminUser.discordId}, ${"BAN_USER"}, ${discord_id}, ${reason})
    `;
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }

  await revokeAllForUser(discord_id, adminUser.discordId);
  invalidateBanCache(discord_id);
  return c.json({ ok: true });
});

admin.post("/api/admin/users/:id/timeout", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const discord_id = c.req.param("id");
  const body = await c.req.json().catch(() => ({} as { reason?: string; hours?: number }));
  const reason = body.reason ?? "No reason provided";
  const rawHours = Number(body.hours);
  const hours = Number.isFinite(rawHours)
    ? Math.max(1, Math.min(8760, Math.floor(rawHours)))
    : 24;
  await ensureUserExists(discord_id);
  const sql = getDb();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  try {
    await sql`
      insert into banned_users (discord_id, reason, banned_at, expires_at)
      values (${discord_id}, ${reason}, ${new Date().toISOString()}, ${expiresAt})
    `;
    await sql`
      insert into action_logs (actor_id, action, target_id, reason, metadata)
      values (
        ${adminUser.discordId},
        ${"TIMEOUT_USER"},
        ${discord_id},
        ${reason},
        ${sql.json({ hours, expires_at: expiresAt })}
      )
    `;
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }

  await revokeAllForUser(discord_id, adminUser.discordId);
  invalidateBanCache(discord_id);
  return c.json({ ok: true });
});

admin.post("/api/admin/users/:id/unban", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const discord_id = c.req.param("id");
  const { reason } = await c.req.json().catch(() => ({ reason: "No reason provided" }));
  await ensureUserExists(discord_id);
  const sql = getDb();
  try {
    await sql`
      update banned_users
        set unbanned_at = ${new Date().toISOString()}
      where discord_id = ${discord_id} and unbanned_at is null
    `;
    await sql`
      insert into action_logs (actor_id, action, target_id, reason)
      values (${adminUser.discordId}, ${"UNBAN_USER"}, ${discord_id}, ${reason})
    `;
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }

  invalidateBanCache(discord_id);
  return c.json({ ok: true });
});

admin.get("/api/admin/action-logs", requireAdmin, async (c) => {
  const sql = getDb();
  const search = (c.req.query("search") || "").trim().toLowerCase();
  const actionFilter = c.req.query("action") || "";
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = (page - 1) * limit;

  const safeSearch = sanitizeSearch(search);
  const searchPat = `%${safeSearch}%`;
  const actionCond = actionFilter ? sql`and action = ${actionFilter}` : sql``;
  const searchCond = safeSearch
    ? sql`and (actor_id ilike ${searchPat} or target_id ilike ${searchPat})`
    : sql``;

  try {
    const [data, [{ count }]] = await Promise.all([
      sql<Array<Record<string, unknown>>>`
        select * from action_logs
        where 1 = 1 ${actionCond} ${searchCond}
        order by created_at desc
        limit ${limit} offset ${offset}
      `,
      sql<{ count: number }[]>`
        select count(*)::int as count from action_logs
        where 1 = 1 ${actionCond} ${searchCond}
      `,
    ]);

    const userIds = Array.from(
      new Set([
        ...data.map((r) => r.actor_id as string),
        ...data.map((r) => r.target_id as string | null).filter((v): v is string => Boolean(v)),
      ]),
    );
    const usersMap = await getUsersByIds(userIds);

    const logs = data.map((r) => ({
      ...r,
      actor_username: usersMap[r.actor_id as string]?.username || "Unknown",
      target_username: r.target_id
        ? usersMap[r.target_id as string]?.username || (r.target_id as string)
        : null,
      actor_avatar: usersMap[r.actor_id as string]?.avatar || null,
      target_avatar: r.target_id
        ? usersMap[r.target_id as string]?.avatar || null
        : null,
    }));

    return c.json({ logs, totalCount: Number(count) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ─── Limits & config (tiers / providers / app_config) ─────────────────
//
// Every write here records an action_logs row (actor = admin's discord id,
// action, human description, before/after metadata, timestamp) so the
// existing "Action Logs" admin tab is a full edit history.

/** Coerce a UI value to a non-negative int, or null (= "not enforced"). */
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

async function logCfg(
  actorId: string,
  action: string,
  targetId: string,
  reason: string,
  metadata: unknown,
): Promise<void> {
  const sql = getDb();
  await sql`
    insert into action_logs (actor_id, action, target_id, reason, metadata)
    values (${actorId}, ${action}, ${targetId}, ${reason}, ${sql.json(metadata as never)})
  `;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

function diffSummary(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  labels: Record<string, string> = {},
): string {
  const skip = new Set(["updated_at", "updated_by"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (skip.has(k)) continue;
    const prev = before[k];
    const prevNorm = prev === undefined || prev === "" ? null : prev;
    const nextNorm = v === undefined || v === "" ? null : v;
    if (prevNorm === nextNorm) continue;
    const label = labels[k] ?? k;
    parts.push(`${label} ${fmtVal(prev)}→${fmtVal(v)}`);
  }
  return parts.join(", ");
}

const APP_CONFIG_KEYS = [
  "discord_server_id",
  "discord_required_role_id",
  "discord_admin_role_ids",
  "discord_staff_channel_id",
  "discord_status_channel_id",
  "global_rpm",
  "global_rpd",
  "global_tpd",
] as const;

admin.get("/api/admin/config", requireAdmin, async (c) => {
  const sql = getDb();
  try {
    const rows = await sql<{ key: string; value: string | null }[]>`
      select key, value from app_config
    `;
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value ?? "";
    return c.json({ config: cfg });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.put("/api/admin/config", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const updates: Array<{ key: string; value: string }> = [];
  for (const key of APP_CONFIG_KEYS) {
    if (!(key in body)) continue;
    let value: string;
    if (key.startsWith("global_")) {
      const n = intOrNull(body[key]);
      if (body[key] !== "" && body[key] !== null && n === null) {
        return c.json({ error: `${key} must be a non-negative integer` }, 400);
      }
      value = n === null ? "" : String(n);
    } else {
      value = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    }
    updates.push({ key, value });
  }
  if (updates.length === 0) {
    return c.json({ error: "No valid config keys provided" }, 400);
  }

  const sql = getDb();
  try {
    const keyList = updates.map((u) => u.key);
    const before = await sql<{ key: string; value: string | null }[]>`
      select key, value from app_config where key in ${sql(keyList)}
    `;

    for (const u of updates) {
      await sql`
        insert into app_config (key, value, updated_at, updated_by)
        values (${u.key}, ${u.value}, ${new Date().toISOString()}, ${adminUser.discordId})
        on conflict (key) do update
          set value = excluded.value,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by
      `;
    }

    const beforeMap: Record<string, unknown> = {};
    for (const r of before) beforeMap[r.key] = r.value;
    const patchMap: Record<string, unknown> = {};
    for (const u of updates) patchMap[u.key] = u.value;
    const diff = diffSummary(beforeMap, patchMap);
    const detail = diff
      ? `Updated app_config: ${diff}`
      : `Updated app_config: ${updates.map((u) => u.key).join(", ")} (no-op)`;

    await logCfg(
      adminUser.discordId,
      "UPDATE_CONFIG",
      "app_config",
      detail,
      { before, after: updates },
    );
    invalidateAppConfig();
    invalidateLimitConfig();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.get("/api/admin/tiers", requireAdmin, async (c) => {
  const sql = getDb();
  try {
    const data = await sql<Array<Record<string, unknown>>>`
      select * from tiers
      order by priority desc, id asc
    `;
    return c.json({ tiers: data });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/api/admin/tiers", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const roleId =
    typeof b.discord_role_id === "string" ? b.discord_role_id.trim() : "";
  if (!name || !roleId) {
    return c.json({ error: "name and discord_role_id are required" }, 400);
  }
  const row = {
    name,
    discord_role_id: roleId,
    priority: intOrNull(b.priority) ?? 0,
    rpm: intOrNull(b.rpm),
    rpd: intOrNull(b.rpd),
    tpd: intOrNull(b.tpd),
    updated_by: adminUser.discordId,
  };
  const sql = getDb();
  let data: Record<string, unknown>;
  try {
    [data] = await sql<Array<Record<string, unknown>>>`
      insert into tiers (name, discord_role_id, priority, rpm, rpd, tpd, updated_by)
      values (${row.name}, ${row.discord_role_id}, ${row.priority}, ${row.rpm}, ${row.rpd}, ${row.tpd}, ${row.updated_by})
      returning *
    `;
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    const dup = msg.includes("duplicate") || msg.includes("unique");
    return c.json(
      { error: dup ? "A tier with that Discord role already exists" : (err as Error).message },
      dup ? 409 : 500,
    );
  }
  await logCfg(
    adminUser.discordId,
    "CREATE_TIER",
    String(data.id),
    `Created tier "${name}" (role ${roleId})`,
    row,
  );
  invalidateLimitConfig();
  return c.json({ tier: data });
});

admin.patch("/api/admin/tiers/:id", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const patch: Record<string, unknown> = { updated_by: adminUser.discordId };
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.discord_role_id === "string" && b.discord_role_id.trim())
    patch.discord_role_id = b.discord_role_id.trim();
  if ("priority" in b) patch.priority = intOrNull(b.priority) ?? 0;
  if ("rpm" in b) patch.rpm = intOrNull(b.rpm);
  if ("rpd" in b) patch.rpd = intOrNull(b.rpd);
  if ("tpd" in b) patch.tpd = intOrNull(b.tpd);

  const sql = getDb();
  try {
    const [before] = await sql<Array<Record<string, unknown>>>`
      select * from tiers where id = ${id} limit 1
    `;
    if (!before) return c.json({ error: "Tier not found" }, 404);

    await sql`update tiers set ${sql(patch)} where id = ${id}`;

    const tierName = (patch.name as string) ?? (before.name as string);
    const diff = diffSummary(before, patch, { discord_role_id: "role" });
    const detail = diff
      ? `Updated tier "${tierName}": ${diff}`
      : `Updated tier "${tierName}" (no changes)`;

    await logCfg(
      adminUser.discordId,
      "UPDATE_TIER",
      String(id),
      detail,
      { before, after: patch },
    );
    invalidateLimitConfig();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.delete("/api/admin/tiers/:id", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid id" }, 400);
  const sql = getDb();
  try {
    const [before] = await sql<Array<Record<string, unknown>>>`
      select * from tiers where id = ${id} limit 1
    `;
    if (!before) return c.json({ error: "Tier not found" }, 404);

    await sql`delete from tiers where id = ${id}`;

    await logCfg(
      adminUser.discordId,
      "DELETE_TIER",
      String(id),
      `Deleted tier "${before.name as string}"`,
      before,
    );
    invalidateLimitConfig();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ─── Providers (limits + dynamic OpenAI-compatible CRUD) ───────────────

const PREFIX_RE = /^[a-z0-9]{2,4}$/;

function invalidateProviderCaches(): void {
  invalidateLimitConfig();
  invalidateProviderRegistry();
}

function safeProvider(
  row: Record<string, unknown>,
  counts?: { total: number; enabled: number },
  owner?: { id: string; username: string; avatar: string | null } | null,
  viewerIsOwner = false,
) {
  return {
    id: row.id,
    display_name: row.display_name,
    enabled: row.enabled,
    // Default to visible when the column is absent/null so a pre-migration
    // read never makes the panel show everything as hidden.
    visible: row.visible ?? true,
    kind: (row.kind as string) ?? "builtin",
    prefix: (row.prefix as string) ?? (row.id as string),
    base_url: viewerIsOwner ? ((row.base_url as string) ?? "") : "",
    has_base_url: Boolean(row.base_url),
    has_api_key: Boolean(row.api_key),
    extra_headers: row.extra_headers ?? null,
    per_user_rpm: row.per_user_rpm ?? null,
    per_user_rpd: row.per_user_rpd ?? null,
    per_user_tpd: row.per_user_tpd ?? null,
    global_rpm: row.global_rpm ?? null,
    global_rpd: row.global_rpd ?? null,
    global_tpd: row.global_tpd ?? null,
    models_synced_at: row.models_synced_at ?? null,
    model_count: counts?.total ?? 0,
    model_enabled_count: counts?.enabled ?? 0,
    owner_id: (row.owner_id as string | null) ?? null,
    owner: owner ?? null,
    viewer_is_owner: viewerIsOwner,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  };
}

function buildSeedRows(
  upstream: Array<{ id: string; owned_by?: string }>,
  providerId: string,
  updatedBy: string,
  takenDisplayNames: Iterable<string> = [],
): Array<{
  provider_id: string;
  upstream_id: string;
  display_name: string;
  enabled: boolean;
  owned_by: string | null;
  updated_by: string;
}> {
  const taken = new Set<string>(
    Array.from(takenDisplayNames, (n) => n.toLowerCase()),
  );
  const seenUpstream = new Set<string>();
  const rows: ReturnType<typeof buildSeedRows> = [];
  for (const m of upstream) {
    if (seenUpstream.has(m.id)) continue;
    seenUpstream.add(m.id);
    let display = m.id;
    let n = 2;
    while (taken.has(display.toLowerCase())) {
      display = `${m.id}-${n++}`;
    }
    taken.add(display.toLowerCase());
    rows.push({
      provider_id: providerId,
      upstream_id: m.id,
      display_name: display,
      enabled: true,
      owned_by: m.owned_by ?? null,
      updated_by: updatedBy,
    });
  }
  return rows;
}

function classifyResponseBody(text: string): {
  outcome: "works" | "broken" | "transient";
  detail: string;
} {
  let firstJson: unknown = null;
  try {
    firstJson = JSON.parse(text);
  } catch {
    for (const line of text.split("\n")) {
      const m = /^data:\s*(\{.*\})\s*$/.exec(line);
      if (!m) continue;
      try {
        firstJson = JSON.parse(m[1]);
        break;
      } catch {
        /* try next chunk */
      }
    }
  }
  if (!firstJson || typeof firstJson !== "object") return { outcome: "works", detail: "ok" };

  const errField = (firstJson as { error?: unknown }).error;
  if (!errField || typeof errField !== "object") return { outcome: "works", detail: "ok" };

  const e = errField as { message?: unknown; code?: unknown; type?: unknown };
  const code = String(e.code ?? "").toLowerCase();
  const type = String(e.type ?? "").toLowerCase();
  const msg = String(e.message ?? "").toLowerCase();
  const blob = `${code} ${type} ${msg}`;
  const RATE_LIMIT_NEEDLES = [
    "rate_limit",
    "rate limit",
    "ratelimit",
    "quota",
    "too_many",
    "too many",
    "try again",
    "no available accounts",
    "capacity",
    "overloaded",
  ];
  if (RATE_LIMIT_NEEDLES.some((n) => blob.includes(n))) {
    return {
      outcome: "transient",
      detail: `200 + rate-limit: ${String(e.message ?? "").slice(0, 100)}`,
    };
  }
  return {
    outcome: "broken",
    detail: `200 + error: ${String(e.message ?? "").slice(0, 100)}`,
  };
}

function ownerIdOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v).trim();
  return /^\d{15,21}$/.test(s) ? s : undefined;
}

function cleanBaseUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/i.test(s)) return null;
  return s;
}

function normalizeHeaders(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.trim() && typeof val === "string" && val.trim()) out[k.trim()] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** Per-provider {total, enabled} model counts, one query. */
async function modelCounts(): Promise<Map<string, { total: number; enabled: number }>> {
  const sql = getDb();
  const m = new Map<string, { total: number; enabled: number }>();
  try {
    const rows = await sql<{ provider_id: string; enabled: boolean }[]>`
      select provider_id, enabled from provider_models
    `;
    for (const r of rows) {
      const e = m.get(r.provider_id) ?? { total: 0, enabled: 0 };
      e.total++;
      if (r.enabled) e.enabled++;
      m.set(r.provider_id, e);
    }
  } catch (err) {
    console.error("[admin] modelCounts failed:", (err as Error).message);
  }
  return m;
}

admin.get("/api/admin/providers", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const sql = getDb();
  try {
    const data = await sql<Array<Record<string, unknown>>>`
      select * from providers order by id asc
    `;
    const counts = await modelCounts();

    const ownerIds = [
      ...new Set(
        data
          .map((r) => r.owner_id as string | null)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    await Promise.all(ownerIds.map((id) => ensureUserExists(id).catch(() => {})));
    const owners = await getUsersByIds(ownerIds);

    return c.json({
      providers: data.map((r) => {
        const oid = (r.owner_id as string | null) ?? null;
        const prof = oid && owners[oid] ? owners[oid] : null;
        return safeProvider(
          r,
          counts.get(r.id as string),
          prof
            ? { id: prof.discordId, username: prof.username, avatar: prof.avatar }
            : null,
          oid === null || oid === adminUser.discordId,
        );
      }),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

async function probeUpstream(cfg: ProviderConfig) {
  return fetchUpstreamModels(cfg);
}

admin.post("/api/admin/providers/validate", requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const baseUrl = cleanBaseUrl(b.base_url);
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
  if (!baseUrl) {
    return c.json(
      { error: "base_url must be a full http(s) URL ending at the API root (…/v1)" },
      400,
    );
  }
  if (!apiKey) return c.json({ error: "api_key is required" }, 400);
  try {
    const list = await probeUpstream({
      id: "validate",
      prefix: "validate",
      baseUrl,
      apiKey,
      extraHeaders: normalizeHeaders(b.extra_headers),
    });
    return c.json({ ok: true, model_count: list.length });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

admin.post("/api/admin/providers", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const displayName =
    typeof b.display_name === "string" ? b.display_name.trim() : "";
  const prefix =
    typeof b.prefix === "string" ? b.prefix.trim().toLowerCase() : "";
  const baseUrl = cleanBaseUrl(b.base_url);
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
  const extraHeaders = normalizeHeaders(b.extra_headers);

  if (!displayName) return c.json({ error: "display_name is required" }, 400);
  if (!PREFIX_RE.test(prefix)) {
    return c.json(
      { error: "prefix must be 2–4 lowercase letters/digits (it's what users type before the model name, e.g. 'gr')" },
      400,
    );
  }
  if (!baseUrl) {
    return c.json(
      { error: "base_url must be a full http(s) URL ending at the API root (…/v1)" },
      400,
    );
  }
  if (!apiKey) return c.json({ error: "api_key is required" }, 400);

  const sql = getDb();
  try {
    const clash = await sql<{ id: string }[]>`
      select id from providers where id = ${prefix} or prefix = ${prefix}
    `;
    if (clash.length > 0) {
      return c.json(
        { error: `Prefix "${prefix}" is already in use by another provider.` },
        409,
      );
    }

    let upstream: Awaited<ReturnType<typeof probeUpstream>>;
    try {
      upstream = await probeUpstream({
        id: prefix,
        prefix,
        baseUrl,
        apiKey,
        extraHeaders,
      });
    } catch (err) {
      return c.json({ error: `Couldn't reach the provider: ${(err as Error).message}` }, 400);
    }

    const parsedOwner = ownerIdOrNull(b.owner_id);
    if (parsedOwner === undefined && b.owner_id !== undefined && b.owner_id !== "") {
      return c.json({ error: "owner_id must be a Discord user id (digits)" }, 400);
    }
    const ownerId = parsedOwner ?? adminUser.discordId;

    const now = new Date().toISOString();
    await sql`
      insert into providers (
        id, display_name, kind, prefix, base_url, api_key, extra_headers,
        owner_id, enabled, models_synced_at, updated_at, updated_by
      ) values (
        ${prefix}, ${displayName}, ${"openai"}, ${prefix}, ${baseUrl},
        ${apiKey}, ${sql.json(extraHeaders as never)}, ${ownerId}, ${true},
        ${now}, ${now}, ${adminUser.discordId}
      )
    `;

    const rows = buildSeedRows(upstream, prefix, adminUser.discordId);
    if (rows.length > 0) {
      try {
        await sql`
          insert into provider_models ${sql(rows as unknown as readonly object[])}
          on conflict (provider_id, upstream_id) do nothing
        `;
      } catch (err) {
        console.error("[admin] provider_models seed failed:", (err as Error).message);
      }
    }

    await logCfg(
      adminUser.discordId,
      "CREATE_PROVIDER",
      prefix,
      `Created provider "${displayName}" (prefix ${prefix}, ${rows.length} models from ${baseUrl})`,
      { base_url: baseUrl, prefix, model_count: rows.length },
    );
    invalidateProviderCaches();
    return c.json({ ok: true, id: prefix, model_count: rows.length });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.patch("/api/admin/providers/:id", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const sql = getDb();
  try {
    const [before] = await sql<Array<Record<string, unknown>>>`
      select * from providers where id = ${id} limit 1
    `;
    if (!before) return c.json({ error: "Provider not found" }, 404);
    const isBuiltin = ((before.kind as string) ?? "builtin") === "builtin";

    if (!isBuiltin) {
      const ownerId = (before.owner_id as string | null) ?? null;
      if (ownerId !== null && ownerId !== adminUser.discordId) {
        return c.json(
          { error: "Only this provider's owner can modify it." },
          403,
        );
      }
    }

    const patch: Record<string, unknown> = { updated_by: adminUser.discordId };
    if (typeof b.display_name === "string" && b.display_name.trim())
      patch.display_name = b.display_name.trim();
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (typeof b.visible === "boolean") patch.visible = b.visible;
    for (const k of [
      "per_user_rpm",
      "per_user_rpd",
      "per_user_tpd",
      "global_rpm",
      "global_rpd",
      "global_tpd",
    ]) {
      if (k in b) patch[k] = intOrNull(b[k]);
    }
    if ("owner_id" in b) {
      const oid = ownerIdOrNull(b.owner_id);
      if (oid === undefined && b.owner_id !== undefined && b.owner_id !== "")
        return c.json({ error: "owner_id must be a Discord user id (digits)" }, 400);
      patch.owner_id = oid ?? null;
    }

    const touchesCreds =
      "base_url" in b || "api_key" in b || "prefix" in b || "extra_headers" in b;
    if (isBuiltin && touchesCreds) {
      return c.json(
        { error: "This is a built-in provider — its URL/key/prefix are managed in code, not the dashboard." },
        400,
      );
    }
    if (!isBuiltin) {
      if ("base_url" in b) {
        const u = cleanBaseUrl(b.base_url);
        if (!u) return c.json({ error: "base_url must be a full http(s) URL" }, 400);
        patch.base_url = u;
      }
      if ("prefix" in b) {
        const p = String(b.prefix ?? "").trim().toLowerCase();
        if (!PREFIX_RE.test(p))
          return c.json({ error: "prefix must be 2–4 lowercase letters/digits" }, 400);
        if (p !== before.prefix) {
          const clash = await sql<{ id: string }[]>`
            select id from providers where prefix = ${p} and id <> ${id}
          `;
          if (clash.length > 0)
            return c.json({ error: `Prefix "${p}" is already in use.` }, 409);
        }
        patch.prefix = p;
      }
      if ("extra_headers" in b)
        patch.extra_headers = normalizeHeaders(b.extra_headers);
      if (typeof b.api_key === "string" && b.api_key.trim())
        patch.api_key = b.api_key.trim();
    }

    await sql`update providers set ${sql(patch)} where id = ${id}`;

    const enabledChanged =
      typeof b.enabled === "boolean" && b.enabled !== before.enabled;
    const action = enabledChanged
      ? `${b.enabled ? "Enabled" : "Disabled"} provider "${id}"`
      : `Updated provider "${id}"`;
    const redact = (o: Record<string, unknown>) =>
      "api_key" in o ? { ...o, api_key: o.api_key ? "***" : "none" } : o;
    const beforeR = redact(before);
    const patchR = redact(patch);
    const diff = diffSummary(beforeR, patchR, { base_url: "base url" });
    const trimmed = enabledChanged
      ? diff.split(", ").filter((p) => !p.startsWith("enabled ")).join(", ")
      : diff;
    const detail = trimmed ? `${action}: ${trimmed}` : action;

    await logCfg(adminUser.discordId, "UPDATE_PROVIDER", id, detail, {
      before: beforeR,
      after: patchR,
    });
    invalidateProviderCaches();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/api/admin/providers/:id/refresh-models", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = c.req.param("id");
  const sql = getDb();
  try {
    const [row] = await sql<Array<Record<string, unknown>>>`
      select * from providers where id = ${id} limit 1
    `;
    if (!row) return c.json({ error: "Provider not found" }, 404);
    if (((row.kind as string) ?? "builtin") !== "openai") {
      return c.json({ error: "Only dynamic providers have a refreshable catalog." }, 400);
    }
    {
      const oid = (row.owner_id as string | null) ?? null;
      if (oid !== null && oid !== adminUser.discordId) {
        return c.json(
          { error: "Only this provider's owner can refresh its model catalog." },
          403,
        );
      }
    }

    let upstream: Awaited<ReturnType<typeof probeUpstream>>;
    try {
      upstream = await probeUpstream({
        id: row.id as string,
        prefix: (row.prefix as string) ?? (row.id as string),
        baseUrl: (row.base_url as string) ?? "",
        apiKey: (row.api_key as string) ?? "",
        extraHeaders: (row.extra_headers as Record<string, string>) ?? null,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    type ExistingRow = {
      id: number;
      upstream_id: string;
      enabled: boolean;
      display_name: string;
    };
    const existing = await sql<ExistingRow[]>`
      select id, upstream_id, enabled, display_name
      from provider_models
      where provider_id = ${id}
    `;
    const have = new Map(existing.map((r) => [r.upstream_id, r]));
    const upstreamIds = new Set(upstream.map((m) => m.id));

    const newOnly = upstream.filter((m) => !have.has(m.id));
    const toInsert = buildSeedRows(
      newOnly,
      id,
      adminUser.discordId,
      existing.map((r) => r.display_name),
    );
    let added = 0;
    if (toInsert.length > 0) {
      await sql`
        insert into provider_models ${sql(toInsert as unknown as readonly object[])}
        on conflict (provider_id, upstream_id) do nothing
      `;
      added = toInsert.length;
    }

    const goneIds = [...have.values()]
      .filter((r) => r.enabled && !upstreamIds.has(r.upstream_id))
      .map((r) => r.id);
    let disabled = 0;
    if (goneIds.length > 0) {
      await sql`
        update provider_models
          set enabled = false, updated_by = ${adminUser.discordId}
        where id in ${sql(goneIds)}
      `;
      disabled = goneIds.length;
    }

    await sql`
      update providers set models_synced_at = ${new Date().toISOString()}
      where id = ${id}
    `;

    await logCfg(
      adminUser.discordId,
      "REFRESH_PROVIDER_MODELS",
      id,
      `Refreshed "${(row.display_name as string) ?? id}": +${added} new, ${disabled} gone-disabled, ${upstream.length} upstream total`,
      { added, disabled, upstream_total: upstream.length },
    );
    invalidateProviderCaches();
    return c.json({ ok: true, added, disabled, upstream_total: upstream.length });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.get("/api/admin/providers/:id/models", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const sql = getDb();
  try {
    const data = await sql<Array<Record<string, unknown>>>`
      select * from provider_models
      where provider_id = ${id}
      order by display_name asc
    `;
    return c.json({ models: data });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.post("/api/admin/providers/:id/probe-model", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const modelId = Number(b.model_id);
  if (!Number.isInteger(modelId) || modelId <= 0)
    return c.json({ error: "Invalid model_id" }, 400);

  const sql = getDb();
  try {
    const [provider] = await sql<Array<Record<string, unknown>>>`
      select * from providers where id = ${id} limit 1
    `;
    if (!provider) return c.json({ error: "Provider not found" }, 404);
    if (((provider.kind as string) ?? "builtin") !== "openai") {
      return c.json(
        { error: "Built-in providers don't have a probable catalog." },
        400,
      );
    }
    {
      const oid = (provider.owner_id as string | null) ?? null;
      if (oid !== null && oid !== adminUser.discordId) {
        return c.json(
          { error: "Only this provider's owner can test its models." },
          403,
        );
      }
    }

    const [model] = await sql<{ id: number; provider_id: string; upstream_id: string; display_name: string; enabled: boolean }[]>`
      select id, provider_id, upstream_id, display_name, enabled
      from provider_models
      where id = ${modelId} and provider_id = ${id}
      limit 1
    `;
    if (!model) return c.json({ error: "Model not found on this provider" }, 404);

    const baseUrl = (provider.base_url as string).replace(/\/+$/, "");
    const apiKey = provider.api_key as string;
    const extraHeaders = (provider.extra_headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15_000);

    let httpStatus = 0;
    let detail = "";
    let outcome: "works" | "broken" | "transient" = "broken";

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.upstream_id,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4,
        }),
        signal: controller.signal,
      });
      httpStatus = res.status;
      const text = await res.text();
      if (res.status === 429) {
        outcome = "transient";
        detail = "rate limited";
      } else if (res.ok) {
        const bodyOutcome = classifyResponseBody(text);
        outcome = bodyOutcome.outcome;
        detail = bodyOutcome.detail;
      } else {
        outcome = "broken";
        detail = `HTTP ${res.status}: ${text.slice(0, 120)}`;
      }
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === "AbortError") {
        outcome = "broken";
        detail = "timeout >15000ms";
      } else {
        outcome = "broken";
        detail = `network: ${(e.message ?? "").slice(0, 100)}`;
      }
    } finally {
      clearTimeout(t);
    }

    let isEnabled = model.enabled;
    if (outcome === "works" && !isEnabled) {
      await sql`
        update provider_models
          set enabled = true, updated_by = ${adminUser.discordId}
        where id = ${modelId}
      `;
      isEnabled = true;
    } else if (outcome === "broken" && isEnabled) {
      await sql`
        update provider_models
          set enabled = false, updated_by = ${adminUser.discordId}
        where id = ${modelId}
      `;
      isEnabled = false;
    }

    return c.json({
      outcome,
      http_status: httpStatus,
      detail,
      model_display_name: model.display_name,
      was_enabled: model.enabled,
      is_enabled: isEnabled,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.patch("/api/admin/provider-models/:mid", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const mid = Number(c.req.param("mid"));
  if (!Number.isInteger(mid) || mid <= 0)
    return c.json({ error: "Invalid id" }, 400);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const sql = getDb();
  try {
    const [before] = await sql<Array<Record<string, unknown>>>`
      select * from provider_models where id = ${mid} limit 1
    `;
    if (!before) return c.json({ error: "Model not found" }, 404);

    const [parent] = await sql<{ owner_id: string | null; kind: string | null }[]>`
      select owner_id, kind from providers
      where id = ${before.provider_id as string} limit 1
    `;
    if (!parent)
      return c.json({ error: "Parent provider not found" }, 404);
    if ((parent.kind ?? "builtin") !== "openai")
      return c.json({ error: "Built-in providers manage their models in code." }, 400);
    {
      const oid = parent.owner_id;
      if (oid !== null && oid !== adminUser.discordId) {
        return c.json(
          { error: "Only this provider's owner can edit its models." },
          403,
        );
      }
    }

    const patch: Record<string, unknown> = { updated_by: adminUser.discordId };
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (typeof b.display_name === "string" && b.display_name.trim()) {
      const name = b.display_name.trim();
      if (name.toLowerCase() !== (before.display_name as string).toLowerCase()) {
        const clash = await sql<{ id: number }[]>`
          select id from provider_models
          where provider_id = ${before.provider_id as string}
            and display_name ilike ${name}
            and id <> ${mid}
        `;
        if (clash.length > 0)
          return c.json(
            { error: `"${name}" is already used by another model on this provider — names must be unique.` },
            409,
          );
      }
      patch.display_name = name;
    }

    await sql`update provider_models set ${sql(patch)} where id = ${mid}`;

    const diff = diffSummary(before, patch);
    await logCfg(
      adminUser.discordId,
      "UPDATE_PROVIDER_MODEL",
      String(before.provider_id),
      diff
        ? `Model on "${before.provider_id}": ${diff}`
        : `Model on "${before.provider_id}" (no change)`,
      { before, after: patch },
    );
    invalidateProviderCaches();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.get("/api/admin/tier-provider-limits", requireAdmin, async (c) => {
  const sql = getDb();
  try {
    const data = await sql<Array<Record<string, unknown>>>`
      select * from tier_provider_limits
    `;
    return c.json({ overrides: data });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

admin.put("/api/admin/tier-provider-limits", requireAdmin, async (c) => {
  const adminUser = c.get("adminUser" as never) as AdminPayload;
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const tierId = Number(b.tier_id);
  const providerId =
    typeof b.provider_id === "string" ? b.provider_id.trim() : "";
  if (!Number.isInteger(tierId) || tierId <= 0 || !providerId) {
    return c.json({ error: "tier_id and provider_id are required" }, 400);
  }
  const rpm = intOrNull(b.rpm);
  const rpd = intOrNull(b.rpd);
  const tpd = intOrNull(b.tpd);

  const sql = getDb();
  try {
    const [tierRow] = await sql<{ name: string }[]>`
      select name from tiers where id = ${tierId} limit 1
    `;
    const tierLabel = tierRow?.name ? `"${tierRow.name}"` : `#${tierId}`;

    const [prevOverride] = await sql<{ rpm: number | null; rpd: number | null; tpd: number | null }[]>`
      select rpm, rpd, tpd from tier_provider_limits
      where tier_id = ${tierId} and provider_id = ${providerId}
      limit 1
    `;

    if (rpm === null && rpd === null && tpd === null) {
      await sql`
        delete from tier_provider_limits
        where tier_id = ${tierId} and provider_id = ${providerId}
      `;
      await logCfg(
        adminUser.discordId,
        "DELETE_TIER_PROVIDER",
        `${tierId}:${providerId}`,
        `Cleared override for tier ${tierLabel} on ${providerId}`,
        { before: prevOverride ?? null },
      );
      invalidateLimitConfig();
      return c.json({ ok: true });
    }

    await sql`
      insert into tier_provider_limits (
        tier_id, provider_id, rpm, rpd, tpd, updated_at, updated_by
      ) values (
        ${tierId}, ${providerId}, ${rpm}, ${rpd}, ${tpd},
        ${new Date().toISOString()}, ${adminUser.discordId}
      )
      on conflict (tier_id, provider_id) do update
        set rpm = excluded.rpm,
            rpd = excluded.rpd,
            tpd = excluded.tpd,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `;

    const after = { rpm, rpd, tpd };
    const diff = prevOverride
      ? diffSummary(prevOverride as Record<string, unknown>, after)
      : "";
    const summary = `rpm=${fmtVal(rpm)}, rpd=${fmtVal(rpd)}, tpd=${fmtVal(tpd)}`;
    const detail = prevOverride
      ? diff
        ? `Updated override for tier ${tierLabel} on ${providerId}: ${diff}`
        : `Updated override for tier ${tierLabel} on ${providerId} (no changes)`
      : `Set override for tier ${tierLabel} on ${providerId}: ${summary}`;
    await logCfg(
      adminUser.discordId,
      "UPSERT_TIER_PROVIDER",
      `${tierId}:${providerId}`,
      detail,
      { before: prevOverride ?? null, after },
    );
    invalidateLimitConfig();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

export default admin;
