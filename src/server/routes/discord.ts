/**
 * Discord interactions endpoint.
 *
 * Discord sends a POST here whenever someone uses one of our slash commands.
 * Each request is signed with Discord's Ed25519 private key; we verify it
 * with our app's public key before doing anything. Unverified requests get
 * a 401, which Discord treats as "your endpoint is broken" rather than
 * passing them along.
 *
 * Two interaction types matter:
 *   - type 1 (PING)       Discord pings on registration; we reply with type 1
 *   - type 2 (APPLICATION_COMMAND)  An actual slash command invocation
 *
 * For each command we check the invoking user has DISCORD_REQUIRED_ROLE_ID
 * in their member.roles array. Discord includes this in the interaction
 * payload for guild commands, so no extra API call is needed.
 *
 * Replies are EPHEMERAL (flags: 64) so only the invoker sees them. This
 * matters because we're sending API keys back and they shouldn't be
 * posted in a public channel.
 *
 * Slash commands handled:
 *   /get-api-key          Issue a new key (or notify if user already has one)
 *   /regenerate-api-key   Revoke all existing keys for this user, issue new
 *   /revoke-api-key       Revoke all keys for this user (no replacement)
 *   /my-keys              List active keys (last_used_at timestamps)
 *   /models               Show all available AI models
 */

import { Hono } from "hono";
import { verifyKey } from "discord-interactions";
import { config } from "../lib/config.js";
import { getAppConfig } from "../lib/app-config.js";
import {
  createKey,
  listKeysForUser,
  revokeAllForUser,
} from "../lib/api-keys.js";
import { getDb } from "../lib/db.js";
import { aggregateModels } from "./models.js";
import { computeStatus, renderText, HEALTH_WINDOW } from "../lib/status.js";
import { upsertUser } from "../lib/users.js";
import { storeUserRoles } from "../lib/user-roles.js";
import { getActiveBan } from "../lib/bans.js";
import { runInBackground } from "../lib/background.js";

const discord = new Hono();

// Discord interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;

// Response types we send back
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
// "ack now, real reply later." Discord shows "Crimson is thinking..."
// to the user and gives us 15 minutes to PATCH the followup webhook
// with the real content. See the doc comment on the POST handler.
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

// Message flag for "ephemeral" (only the invoking user sees it)
const EPHEMERAL = 64;

type InteractionMember = {
  user?: { id: string; username: string; global_name?: string; avatar?: string };
  roles?: string[];
};

type Interaction = {
  type: number;
  data?: { name: string };
  member?: InteractionMember;
  user?: { id: string; username: string; global_name?: string; avatar?: string };
  guild_id?: string;
  // Discord-issued, per-interaction. Used as the credential when PATCHing
  // the followup webhook in the deferred-response flow. Valid for 15 min.
  token?: string;
};

/** Payload shape that lives inside a CHANNEL_MESSAGE_WITH_SOURCE reply
 *  and that the followup PATCH expects verbatim. */
type ReplyData = { content: string; flags: number };

function ephemeralReply(content: string) {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  };
}

function pickUser(i: Interaction): { id: string; username: string; avatar: string | null } | null {
  // In guild commands the user info comes via member.user; in DMs it's
  // directly on the interaction.
  const u = i.member?.user ?? i.user;
  if (!u) return null;
  return { id: u.id, username: u.global_name ?? u.username, avatar: u.avatar ?? null };
}

function hasRequiredRole(i: Interaction, requiredRoleId: string): boolean {
  // If we haven't configured a required role, allow anyone in the server.
  if (!requiredRoleId) return true;
  const roles = i.member?.roles ?? [];
  return roles.includes(requiredRoleId);
}

function wrongServer(i: Interaction, serverId: string): boolean {
  if (!serverId) return false;
  return i.guild_id !== serverId;
}

/**
 * Build usage instructions with endpoint + a link to the dashboard for
 * the model catalog. Included in /get-api-key and /regenerate-api-key
 * replies.
 *
 * The model list lives on the website, NOT inline — once a provider
 * has hundreds of models the inline list blows past Discord's 2000-char
 * message limit and the whole reply silently drops ("Crimson didn't
 * respond in time" from the user's side). The link doesn't have that
 * problem, and the dashboard groups by provider so it's easier to read
 * than a flat list anyway.
 */
function usageInfo(_key: string): string {
  return [
    "",
    "**How to use nya~**",
    "",
    "**Endpoint:**",
    "```",
    "https://app.crimsons-proxy.workers.dev/v1/chat/completions",
    "```",
    "",
    "**Available models:** https://app.crimsons-proxy.workers.dev/",
    "Copy a model id exactly as listed there (the prefix is part of it).",
  ].join("\n");
}

async function handleGetApiKey(i: Interaction) {
  const user = pickUser(i);
  if (!user) return ephemeralReply("Nya?! Can't figure out who you are...");

  // If they already have active keys, tell them to use /regenerate instead.
  const existing = await listKeysForUser(user.id);
  const active = existing.filter((k) => !k.revokedAt);
  if (active.length > 0) {
    return ephemeralReply(
      `Nya? You already have ${active.length} active key(s), silly~ Use \`/regenerate-api-key\` to replace them, or \`/my-keys\` to check on them!`,
    );
  }

  const { key } = await createKey(user.id, user.username);
  const usage = usageInfo(key);

  return ephemeralReply(
    [
      "Nya~ here's your shiny new API key! Keep it safe, okay?",
      "```",
      key,
      "```",
      "**I can only show this once!** If you lose it, run `/regenerate-api-key` nya~",
      usage,
    ].join("\n"),
  );
}

async function handleRegenerate(i: Interaction) {
  const user = pickUser(i);
  if (!user) return ephemeralReply("Nya?! Can't figure out who you are...");

  const revoked = await revokeAllForUser(user.id);
  const { key } = await createKey(user.id, user.username, "regenerated");
  const usage = usageInfo(key);

  return ephemeralReply(
    [
      `Nyaa~ revoked ${revoked} old key(s)! Here's your fresh one:`,
      "```",
      key,
      "```",
      "Update your settings with this new key nya~ The old one(s) won't work anymore!",
      usage,
    ].join("\n"),
  );
}

async function handleRevoke(i: Interaction) {
  const user = pickUser(i);
  if (!user) return ephemeralReply("Nya?! Can't figure out who you are...");

  const revoked = await revokeAllForUser(user.id);
  if (revoked === 0) {
    return ephemeralReply("Nya? You don't have any active keys to revoke~");
  }
  return ephemeralReply(
    `Nya... revoked ${revoked} key(s). They're gone meow~ Run \`/get-api-key\` when you want a new one!`,
  );
}

async function handleMyKeys(i: Interaction) {
  const user = pickUser(i);
  if (!user) return ephemeralReply("Nya?! Can't figure out who you are...");

  const keys = await listKeysForUser(user.id);
  if (keys.length === 0) {
    return ephemeralReply("Nya? You don't have any keys yet~ Use `/get-api-key` to get one!");
  }
  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);

  const lines: string[] = [];
  if (active.length > 0) {
    for (const k of active) {
      const preview = k.keyPreview ? ` \`${k.keyPreview}\`` : "";
      const lastUsed = k.lastUsedAt
        ? `last used ${new Date(k.lastUsedAt).toUTCString()}`
        : "never used";
      lines.push(`✅${preview} — ${lastUsed}`);
    }
  }
  if (revoked.length > 0) {
    lines.push(`❌ ${revoked.length} revoked key(s)`);
  }

  return ephemeralReply(`Nya~ here's your key status:\n${lines.join("\n")}`);
}

async function handleModels() {
  // Inline catalog is OFF — once a single provider can hold hundreds of
  // models (cre/ has ~400), the full list blows past Discord's 2000-char
  // message limit and the reply gets dropped on the floor. Instead we
  // show a per-provider summary with counts, plus a link to the
  // dashboard where the full list lives.
  const all = await aggregateModels();
  const counts = new Map<string, number>();
  for (const m of all) {
    if (m.id.startsWith("mock/")) continue;
    const prefix = m.id.includes("/") ? m.id.split("/", 1)[0] : "(no prefix)";
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([prefix, n]) => `• \`${prefix}/\` — ${n} model${n === 1 ? "" : "s"}`)
    .join("\n");

  return ephemeralReply(
    [
      "Nya~ here's what's available right meow:",
      "",
      summary || "(no models configured yet)",
      "",
      "Browse the full list at https://app.crimsons-proxy.workers.dev/",
      "Copy a model id exactly as listed there (the prefix is part of it).",
    ].join("\n"),
  );
}

/**
 * /health — on-demand model-health snapshot. Same data the live status
 * board renders, but invokable from any channel and returned ephemerally
 * (only the caller sees it) so it doesn't spam threads.
 *
 * Public command, no role check — mirrors how /models is handled.
 * Renders inside a triple-backtick block so the strip uses Discord's
 * monospace font and the model id column lines up.
 */
async function handleHealth() {
  // HEALTH_WINDOW (5) is tighter than the board's DISCORD_WINDOW (8)
  // because /health is an ephemeral on-demand reply — just a quick
  // "is it working right now?" signal, not a passive monitor.
  const statuses = await computeStatus(HEALTH_WINDOW);
  const rendered = renderText(statuses);
  // Discord caps message content at 2000 chars. With window=5 a full
  // catalog stays well under that, but truncate the tail anyway as a
  // defensive measure if a deployment ever has dozens of providers.
  const fenced = "```\n" + rendered + "\n```";
  const safe =
    fenced.length <= 2000
      ? fenced
      : "```\n" + rendered.slice(0, 2000 - 30) + "\n…(truncated)```";
  return ephemeralReply(safe);
}

async function handleStatus(interaction: Interaction) {
  const user = pickUser(interaction);
  if (!user) return ephemeralReply("Nya?! I couldn't find your user info!");

  const sql = getDb();
  type HistoryRow = { unbanned_at: string | null; expires_at: string | null; banned_at: string; reason: string | null };
  let history: HistoryRow[] = [];
  let totalRequests = 0;
  try {
    [history, [{ count: totalRequests }]] = await Promise.all([
      sql<HistoryRow[]>`
        select unbanned_at, expires_at, banned_at, reason
        from banned_users
        where discord_id = ${user.id}
        order by banned_at desc
      `,
      sql<{ count: number }[]>`
        select count(*)::int as count from request_logs where discord_user_id = ${user.id}
      `,
    ]);
  } catch (err) {
    console.error("[discord] /status read failed:", (err as Error).message);
  }

  let statusLines = [];
  statusLines.push(`📊 **Usage:** You have made a total of **${totalRequests || 0}** requests.`);

  if (!history || history.length === 0) {
    statusLines.push("✅ **Status:** Your account is in good standing. No timeouts or bans on record, nya~");
    return ephemeralReply(statusLines.join("\n\n"));
  }

  const activeBan = history.find(h => !h.unbanned_at && (!h.expires_at || new Date(h.expires_at).getTime() > Date.now()));
  
  if (activeBan) {
    if (activeBan.expires_at) {
      statusLines.push(`⏳ **Status:** You are on a timeout until <t:${Math.floor(new Date(activeBan.expires_at).getTime() / 1000)}:f>.`);
    } else {
      statusLines.push(`❌ **Status:** You are permanently banned.`);
    }
    statusLines.push(`**Reason:** ${activeBan.reason || "None given"}\n`);
  } else {
    statusLines.push(`✅ **Status:** Your account is currently active.\n`);
  }

  statusLines.push(`📜 **History (${history.length} records):**`);
  for (const record of history.slice(0, 5)) {
    const date = `<t:${Math.floor(new Date(record.banned_at).getTime() / 1000)}:d>`;
    const type = record.expires_at ? "Timeout" : "Ban";
    statusLines.push(`- ${date}: ${type} (${record.reason || "No reason"})`);
  }

  if (history.length > 5) statusLines.push(`- ...and ${history.length - 5} more.`);

  return ephemeralReply(statusLines.join("\n"));
}

/**
 * Discord interactions endpoint, using the DEFERRED-response pattern.
 *
 * Discord enforces a 3-second deadline on the synchronous reply to the
 * interaction webhook. If we miss it, the user sees "the application did
 * not respond" and our actual reply is dropped on the floor. That deadline
 * is uncomfortable now that every DB query is a TCP+TLS+SCRAM hop to
 * Aiven — a cold Vercel/Worker invocation pays ~5+ round trips before its
 * first query even runs, and the slash command flow does ~3-5 sequential
 * queries (`getAppConfig` → `getActiveBan` → command-specific reads).
 *
 * The deferred pattern decouples the ack from the real reply:
 *
 *   1. Within 3s we respond with `type: 5`
 *      (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE). Discord shows
 *      "Crimson is thinking..." to the user and gives us up to 15 minutes
 *      to deliver the real content.
 *   2. The actual work (config read, role check, ban check, command
 *      handler) runs in the background via lib/background.runInBackground,
 *      which adapts to whichever runtime we're on
 *      (Cloudflare ctx.waitUntil, Vercel request-context waitUntil, or
 *      plain event-loop fire-and-forget on a long-running Node host).
 *   3. When the work finishes we PATCH the followup webhook
 *      (`webhooks/{app_id}/{interaction_token}/messages/@original`) to
 *      replace the "thinking..." placeholder with the real reply (or an
 *      error message). The interaction_token is the credential — no bot
 *      token needed for this hop.
 *
 * PING (type 1) and unknown interaction types stay synchronous: they're
 * static replies that don't touch the DB, so deferring would only add the
 * "thinking..." UI flash without any latency win.
 *
 * `processCommand` wraps the dispatch in a try/catch so a thrown DB error
 * still produces a user-visible error reply via the followup, instead of
 * leaving the user staring at the spinner until token expiry.
 */
discord.post("/discord/interactions", async (c) => {
  if (!config.discordPublicKey) {
    return c.json({ error: "Discord integration not configured" }, 503);
  }

  // Verify the Ed25519 signature against the raw body. verifyKey takes the
  // raw bytes, so we read the body as text BEFORE parsing JSON.
  const signature = c.req.header("X-Signature-Ed25519") ?? "";
  const timestamp = c.req.header("X-Signature-Timestamp") ?? "";
  const rawBody = await c.req.text();

  const valid = await verifyKey(rawBody, signature, timestamp, config.discordPublicKey);
  if (!valid) {
    return c.text("invalid request signature", 401);
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(rawBody) as Interaction;
  } catch {
    return c.text("invalid JSON", 400);
  }

  // Discord's verification ping on first registration. Sync — no DB work.
  if (interaction.type === PING) {
    return c.json({ type: PONG });
  }

  // Unknown / unsupported interaction type. Sync — just static text.
  if (interaction.type !== APPLICATION_COMMAND || !interaction.data) {
    return c.json(ephemeralReply("Nya?! I don't understand that interaction type~"));
  }

  // Defer for every command. processCommand will resolve the reply on
  // its own time and PATCH the followup. The interaction token is the
  // only thing we need to address that webhook later.
  if (!interaction.token) {
    // Discord always includes a token on real interactions; if it's
    // missing we can't defer (followup PATCH has nowhere to go), so
    // fall back to the sync path. In practice this branch should never
    // fire outside of a malformed test payload.
    return c.json(ephemeralReply("Nya?! Missing interaction token~"));
  }

  runInBackground(c, processCommand(interaction));

  // Ephemeral defer: the followup PATCH inherits the ephemeral flag,
  // so even the "thinking..." placeholder is only visible to the invoker.
  return c.json({
    type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL },
  });
});

/**
 * Background half of the deferred flow. Resolves the reply, then PATCHes
 * the followup webhook. Wraps everything in try/catch so the user never
 * gets stuck on the "thinking..." spinner from a thrown error.
 */
async function processCommand(interaction: Interaction): Promise<void> {
  let reply: ReplyData;
  try {
    reply = await resolveReply(interaction);
  } catch (err) {
    console.error(
      `[discord] ${interaction.data?.name ?? "?"} failed in background:`,
      err,
    );
    reply = {
      content: "Nya... that command failed. Try again in a moment~",
      flags: EPHEMERAL,
    };
  }
  await editFollowup(interaction.token!, reply);
}

/**
 * Resolve the reply for a command, doing all the slow work (config read,
 * server/role/ban gates, command handler) here so the synchronous handler
 * can return the deferred ack as fast as possible.
 */
async function resolveReply(interaction: Interaction): Promise<ReplyData> {
  const command = interaction.data!.name;
  const ac = await getAppConfig();

  // Reject commands from the wrong server (if we've locked it down).
  if (wrongServer(interaction, ac.discordServerId)) {
    return {
      content: "Nya?! This command doesn't work in this server~",
      flags: EPHEMERAL,
    };
  }

  // /models is public (no role check needed).
  if (command === "models") {
    return (await handleModels()).data;
  }

  // All other commands require the role.
  if (!hasRequiredRole(interaction, ac.discordRequiredRoleId)) {
    return {
      content:
        "Nya?! You don't have the required role to use this command~ Ask a server admin for access!",
      flags: EPHEMERAL,
    };
  }

  const user = pickUser(interaction);
  if (user) {
    // Keep the users table fresh so action logs can always resolve names/avatars.
    upsertUser({ discordId: user.id, username: user.username, avatar: user.avatar }).catch(() => {});

    // Roles are in the signed interaction payload — persist them for free
    // so the /v1 tier check rarely needs a live Discord fetch.
    storeUserRoles(user.id, interaction.member?.roles ?? []).catch(() => {});

    const ban = await getActiveBan(user.id);
    if (ban && command !== "status") {
      if (ban.expiresAt) {
        const timeFormat = `<t:${Math.floor(new Date(ban.expiresAt).getTime() / 1000)}:R>`;
        return {
          content: `Nya... you are on a timeout until ${timeFormat}. Reason: ${ban.reason || "None given"}`,
          flags: EPHEMERAL,
        };
      }
      return {
        content: "Nya... you have been permanently banned from using this service. 😿",
        flags: EPHEMERAL,
      };
    }
  }

  switch (command) {
    case "get-api-key":
      return (await handleGetApiKey(interaction)).data;
    case "regenerate-api-key":
      return (await handleRegenerate(interaction)).data;
    case "revoke-api-key":
      return (await handleRevoke(interaction)).data;
    case "my-keys":
      return (await handleMyKeys(interaction)).data;
    case "status":
      return (await handleStatus(interaction)).data;
    case "health":
      return (await handleHealth()).data;
    default:
      return {
        content: `Nya? I don't know the command: ${command}`,
        flags: EPHEMERAL,
      };
  }
}

/**
 * Edit the deferred "thinking..." placeholder in place with the real
 * reply. The interaction_token authorizes this hop — no bot token
 * needed. We log non-2xx responses but never throw: by this point the
 * sync handler has long since returned, so a failure here just leaves
 * the user looking at the spinner.
 */
async function editFollowup(token: string, data: ReplyData): Promise<void> {
  if (!config.discordAppId) {
    console.error("[discord] DISCORD_APP_ID missing; can't PATCH followup");
    return;
  }
  const url = `https://discord.com/api/v10/webhooks/${config.discordAppId}/${token}/messages/@original`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[discord] followup PATCH ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error("[discord] followup PATCH threw:", (err as Error).message);
  }
}

export default discord;
