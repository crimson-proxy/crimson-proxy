import { Hono } from "hono";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { config } from "../lib/config.js";
import { getAppConfig } from "../lib/app-config.js";
import { listKeysForUser } from "../lib/api-keys.js";
import { getDb, hasDb } from "../lib/db.js";
import { getActiveBan } from "../lib/bans.js";
import { upsertUser } from "../lib/users.js";
import { storeUserRoles } from "../lib/user-roles.js";
import { getSessionUser } from "../lib/session.js";

const auth = new Hono();

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function signingKey() {
  return new TextEncoder().encode(config.adminSigningSecret);
}

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string;
  avatar?: string;
};

type GuildMember = {
  roles: string[];
  user?: DiscordUser;
};

/**
 * GET /api/auth/config
 * Returns the Discord client ID so the frontend can construct the OAuth URL.
 * No secrets are exposed.
 */
auth.get("/api/auth/config", (c) => {
  if (!config.discordAppId) {
    return c.json({ error: "Discord integration not configured" }, 503);
  }
  return c.json({ clientId: config.discordAppId });
});

/**
 * POST /api/auth/discord/callback
 * Body: { code: string, redirectUri: string }
 * Returns: { token: string, user: { id, username, avatar } }
 */
auth.post("/api/auth/discord/callback", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    code?: string;
    redirectUri?: string;
  };

  if (!body.code || !body.redirectUri) {
    return c.json({ error: "code and redirectUri are required" }, 400);
  }

  if (!config.discordAppId || !config.discordClientSecret) {
    return c.json({ error: "Discord OAuth not configured" }, 503);
  }

  // Exchange the authorization code for an access token.
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.discordAppId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: body.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error("[auth] Discord token exchange failed:", text);
    return c.json({ error: "Discord authentication failed" }, 401);
  }

  const tokenData = (await tokenRes.json()) as { access_token: string };

  // Fetch the user's Discord profile.
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    return c.json({ error: "Failed to fetch Discord user info" }, 401);
  }

  const discordUser = (await userRes.json()) as DiscordUser;

  // Check guild membership and role using the bot token. Server/role ids
  // come from DB config (env fallback); the bot token stays env (secret).
  const ac = await getAppConfig();
  let isAdmin = false;
  if (ac.discordServerId && config.discordBotToken) {
    const memberRes = await fetch(
      `https://discord.com/api/guilds/${ac.discordServerId}/members/${discordUser.id}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      },
    );

    if (!memberRes.ok) {
      return c.json(
        { error: "You must be a member of the Discord server to access this dashboard." },
        403,
      );
    }

    const member = (await memberRes.json()) as GuildMember;

    // We just fetched the member — persist roles for free so the /v1 tier
    // check rarely needs its own live Discord call.
    storeUserRoles(discordUser.id, member.roles ?? []).catch(() => {});

    if (ac.discordRequiredRoleId) {
      if (!member.roles.includes(ac.discordRequiredRoleId)) {
        return c.json(
          { error: "You don't have the required role. Ask a server admin for access." },
          403,
        );
      }
    }

    if (ac.discordAdminRoleIds.length > 0) {
      isAdmin = ac.discordAdminRoleIds.some((roleId) =>
        member.roles.includes(roleId),
      );
    }
  }

  // Persist / refresh the user's profile in our users table.
  const username = discordUser.global_name ?? discordUser.username;
  const avatar = discordUser.avatar ?? null;
  await upsertUser({ discordId: discordUser.id, username, avatar });

  // Issue a session JWT.
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    type: "session",
    sub: discordUser.id,
    username,
    avatar,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(signingKey());

  return c.json({
    token,
    user: {
      id: discordUser.id,
      username,
      avatar,
    },
    isAdmin,
  });
});

/**
 * GET /api/auth/me
 * Verify the session JWT and return the user info embedded in it.
 * Also checks if the user has any admin roles and returns isAdmin flag.
 */
auth.get("/api/auth/me", async (c) => {
  const user = await getSessionUser(c.req.header("Authorization"));
  if (!user) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  // Check admin roles if configured. Server/admin-role ids from DB config
  // (env fallback); bot token stays env (secret).
  const ac = await getAppConfig();
  let isAdmin = false;
  if (
    ac.discordServerId &&
    config.discordBotToken &&
    ac.discordAdminRoleIds.length > 0
  ) {
    try {
      const memberRes = await fetch(
        `https://discord.com/api/guilds/${ac.discordServerId}/members/${user.sub}`,
        { headers: { Authorization: `Bot ${config.discordBotToken}` } },
      );
      if (memberRes.ok) {
        const member = (await memberRes.json()) as { roles: string[] };
        // Refresh cached roles for free while we have them.
        storeUserRoles(user.sub, member.roles ?? []).catch(() => {});
        isAdmin = ac.discordAdminRoleIds.some((r) =>
          member.roles.includes(r),
        );
      }
    } catch {
      // Silently fail — just won't show admin button.
    }
  }

  return c.json({
    user: { id: user.sub, username: user.username, avatar: user.avatar },
    isAdmin,
  });
});

/**
 * GET /api/keys
 * Returns the logged-in user's API keys from Supabase. Keys are identified
 * by the Discord user ID embedded in the session JWT. Only metadata is
 * returned (never the plaintext key — we only store hashes).
 */
auth.get("/api/keys", async (c) => {
  const user = await getSessionUser(c.req.header("Authorization"));
  if (!user) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  if (!hasDb()) {
    return c.json({ keys: [], source: "none" });
  }

  try {
    const keys = await listKeysForUser(user.sub);
    return c.json({
      keys: keys.map((k) => ({
        id: k.id,
        keyPreview: k.keyPreview,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
        lastUsedAt: k.lastUsedAt,
        notes: k.notes,
      })),
    });
  } catch (err) {
    console.error("[auth] list keys failed:", (err as Error).message);
    return c.json({ error: "Failed to fetch keys" }, 500);
  }
});

/**
 * GET /api/me/logs?range=24h&status=all&model=&page=1&limit=20
 *
 * Returns the logged-in user's own request history. Scoped by the
 * session JWT's discord_user_id — never trust a query param for the
 * user filter.
 *
 * Deliberately strips per-request internal fields the user has no
 * business seeing: `via` (provider id), `account_id`, `account_label`
 * (which upstream account served them), and the raw `error` body text
 * (status code is enough; the error body sometimes leaks upstream
 * provider names per AI.md rules). Tokens, model, duration, status —
 * those are user-relevant and stay.
 */
auth.get("/api/me/logs", async (c) => {
  const user = await getSessionUser(c.req.header("Authorization"));
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  if (!hasDb()) {
    return c.json({ logs: [], totalCount: 0, models: [], summary: emptyLogSummary() });
  }

  const range = (c.req.query("range") ?? "24h").toLowerCase();
  const statusFilter = (c.req.query("status") ?? "all").toLowerCase();
  const modelFilter = (c.req.query("model") ?? "").trim();
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = (page - 1) * limit;

  const since = rangeToSince(range);

  const sql = getDb();

  // Compose WHERE clauses as fragments so the same set of filters can be
  // reused across the page / count / summary / distinct-models queries.
  const sinceCond = since ? sql`and created_at >= ${since}` : sql``;
  const modelCond = modelFilter ? sql`and model = ${modelFilter}` : sql``;
  const statusCond =
    statusFilter === "success"
      ? sql`and status < 400`
      : statusFilter === "error"
        ? sql`and status >= 400`
        : sql``;

  try {
    type Row = {
      id: number;
      created_at: string;
      status: number;
      error_type: string | null;
      duration_ms: number;
      model: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
    };
    const data = await sql<Row[]>`
      select id, created_at, status, error_type, duration_ms, model,
             prompt_tokens, completion_tokens, total_tokens
      from request_logs
      where discord_user_id = ${user.sub}
        ${sinceCond} ${modelCond} ${statusCond}
      order by created_at desc
      limit ${limit} offset ${offset}
    `;
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from request_logs
      where discord_user_id = ${user.sub}
        ${sinceCond} ${modelCond} ${statusCond}
    `;

    // Summary aggregates across the whole filtered range (not just this
    // page). Deliberately ignores statusFilter so success-rate is meaningful.
    type SummaryRow = {
      status: number;
      duration_ms: number | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
    };
    const summaryRows = await sql<SummaryRow[]>`
      select status, duration_ms, prompt_tokens, completion_tokens, total_tokens
      from request_logs
      where discord_user_id = ${user.sub} ${sinceCond} ${modelCond}
    `;
    const summary = summarizeUserLogs(summaryRows);

    // Distinct models the user has called in this range — drives the UI dropdown.
    const modelRows = await sql<{ model: string }[]>`
      select distinct model from request_logs
      where discord_user_id = ${user.sub}
        and model is not null
        ${sinceCond}
      order by model
      limit 500
    `;
    const models = modelRows.map((r) => r.model).filter(Boolean);

    return c.json({
      logs: data,
      totalCount: Number(count),
      models,
      summary,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

function rangeToSince(range: string): string | null {
  const now = Date.now();
  switch (range) {
    case "24h": return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case "7d":  return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d": return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "all": return null;
    default:    return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  }
}

function emptyLogSummary() {
  return {
    requests: 0,
    successful: 0,
    errors: 0,
    successRate: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    avgDurationMs: 0,
  };
}

function summarizeUserLogs(rows: any[]) {
  const s = emptyLogSummary();
  if (rows.length === 0) return s;
  let durSum = 0;
  for (const r of rows) {
    s.requests++;
    if (r.status >= 200 && r.status < 400) s.successful++;
    else s.errors++;
    s.promptTokens += Number(r.prompt_tokens ?? 0);
    s.completionTokens += Number(r.completion_tokens ?? 0);
    s.totalTokens += Number(r.total_tokens ?? 0);
    durSum += Number(r.duration_ms ?? 0);
  }
  s.successRate = s.requests > 0 ? Math.round((s.successful / s.requests) * 1000) / 10 : 0;
  s.avgDurationMs = Math.round(durSum / s.requests);
  return s;
}

auth.get("/api/user/status", async (c) => {
  const user = await getSessionUser(c.req.header("Authorization"));
  if (!user) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  if (!hasDb()) {
    return c.json({ isBanned: false });
  }

  // Resolve the current ban (lazy-lifts expired timeouts as a side effect)
  // before we read the history so the row we return reflects the post-lift state.
  const activeBan = await getActiveBan(user.sub);

  const sql = getDb();
  let history: Record<string, unknown>[] = [];
  try {
    history = await sql<Record<string, unknown>[]>`
      select * from banned_users
      where discord_id = ${user.sub}
      order by banned_at desc
    `;
  } catch (err) {
    console.error("[auth] /user/status history failed:", (err as Error).message);
  }

  return c.json({
    isBanned: !!activeBan,
    activeBan: activeBan
      ? {
          reason: activeBan.reason,
          expires_at: activeBan.expiresAt,
        }
      : null,
    history,
  });
});

export default auth;

