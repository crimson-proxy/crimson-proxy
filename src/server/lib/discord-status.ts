/**
 * Live Discord status board.
 *
 * Posts (and edits in place) a SET of messages in a configured Discord
 * channel showing the model-health strip rendered by /status:
 *   - one "header" message with the title + a live "updated <t:UNIX:R>"
 *     relative timestamp (Discord renders it client-side, so the
 *     "X seconds/minutes ago" ticks automatically without us editing)
 *   - one message per provider that has traffic, listing only that
 *     provider's models (alphabetical). New providers added via /admin
 *     get a new message lazily on the first refresh that has data for
 *     them — no admin step required.
 *
 * Triggered fire-and-forget by chat.ts after every /v1/chat/completions
 * appendLog — no cron, no setInterval, serverless-safe.
 *
 * ─── How it stays cheap ───────────────────────────────────────────────
 * - Throttled: at most one Discord refresh per THROTTLE_MS window. A
 *   burst of 100 chat requests in a minute fires one refresh, not 100.
 * - Per refresh: 1 + (providers-with-data) Discord HTTP calls. With
 *   ~3-5 providers, well under any rate limit.
 * - State lives in app_config (DB), so any warm Vercel instance can
 *   honor the throttle — process-local memory wouldn't survive cold
 *   starts and would drift across instances.
 * - getAppConfig() is already cached 30s by lib/app-config.ts, so the
 *   throttle check itself is free in the common case (cache hit, no
 *   DB round-trip, return early).
 *
 * ─── Failure model ────────────────────────────────────────────────────
 * Every step is best-effort. A 5xx from Discord, a network timeout, a
 * Supabase hiccup writing the new message-id map — all logged to console
 * and swallowed. The next chat request (after the throttle expires)
 * tries again. Chat traffic must NEVER fail because the board logic
 * threw.
 *
 * ─── Concurrency ──────────────────────────────────────────────────────
 * Every Cloudflare isolate (and the Vercel mirror) fires this fire-and-
 * forget after a chat request, so many refreshes race. They are serialized
 * by an atomic claim on the `discord_status_last_edit_at` row
 * (claimThrottleWindow): the conditional UPDATE row-locks in Postgres, so
 * exactly one caller wins each THROTTLE_MS window and the rest return
 * immediately. Before this lock the throttle was a 30s-cached per-isolate
 * read, written only at the END of the refresh, so several isolates passed
 * it at once; each then posted/purged against its own stale copy of the
 * message-id map and the board churned — deleting and reposting messages
 * instead of editing them in place.
 *
 * ─── Per-provider chunking ────────────────────────────────────────────
 * One Discord message caps at 2000 chars. A provider with hundreds of
 * active models (cre/ peaks well past 100 rows during busy hours)
 * blows past that — pre-chunking we just truncated the tail, which
 * meant the same provider's message would flicker between different
 * "surviving" models on each refresh as sort order changed.
 *
 * Now a provider's rows are PACKED into multiple chunks if needed.
 * Each chunk is its own Discord message keyed `${providerId}:${i}` in
 * the map. The header above the fence reads `# CRE (1/3)` when there
 * are multiple chunks, plain `# CRE` when there's only one. Within a
 * provider, columns line up across chunks because the row strings are
 * pre-rendered against the full row set before slicing.
 *
 * Chunk-count thrashing (an active model that's right at the boundary
 * pushing the provider from 2→3→2 chunks across refreshes) is the only
 * way edits stop being silent. Mitigated with a small hysteresis: we
 * only shrink when the smaller layout fits comfortably, never when it'd
 * be one row away from growing back.
 *
 * ─── Migration ────────────────────────────────────────────────────────
 * v1 stored discord_status_message_id as a plain string. v2 stored a
 * JSON map { "header": "...", "<providerId>": "...", ... }. v3 keys
 * providers by chunk: `{ "header": "...", "<providerId>:0": "...",
 * "<providerId>:1": "..." }`. parseMessageMap migrates v2 keys to v3
 * by treating a bare provider key as chunk 0; legacy v1 plain strings
 * still start fresh (no JSON object → {}).
 */

import { config } from "./config.js";
import { getAppConfig, setAppConfigKey, claimThrottleWindow } from "./app-config.js";
import {
  computeStatus,
  renderHeader,
  renderRows,
  type ModelStatus,
  DISCORD_WINDOW,
} from "./status.js";

const DISCORD_API = "https://discord.com/api/v10";

/** Edit at most once per this interval. User-requested 5 minutes. */
const THROTTLE_MS = 5 * 60 * 1000;

/** The reserved key inside the message-id map for the title/timestamp message. */
const HEADER_KEY = "header";

/**
 * The reserved key inside the message-id map for the standalone dashboard
 * link banner that sits at the very top of the channel, above all provider
 * status messages. Posted FIRST on each refresh so Discord (oldest-first)
 * renders it at the top.
 *
 * Note: when this key is added to an existing channel that already has the
 * bot's old messages, the new banner will initially land at the BOTTOM
 * because Discord can't reorder posts. Operator must manually delete the
 * bot's existing messages once after deploy; the next refresh reposts
 * everything in the new order with this banner on top.
 */
const DASHBOARD_LINK_KEY = "dashboard_link";

/** Public dashboard status page. The body of the top banner message. */
const DASHBOARD_LINK_BODY = "https://app.crimsons-proxy.workers.dev/status";

type MessageMap = Record<string, string>;

/**
 * Parse the app_config value into a {key: messageId} map.
 *
 * Accepts:
 *   - JSON object (v2 format)            → use as-is
 *   - empty string                       → {} (feature never used)
 *   - non-JSON string (v1 legacy format) → {} (start fresh; orphan
 *                                            stays in channel for the
 *                                            user to clean up)
 *   - JSON that isn't an object          → {} (defensive; same as legacy)
 */
function parseMessageMap(raw: string): MessageMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: MessageMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || !v) continue;
    if (k === HEADER_KEY || k === DASHBOARD_LINK_KEY || k.includes(":")) {
      out[k] = v;
    } else {
      // v2 → v3 migration. A bare provider key (no colon) used to mean
      // "the single message for this provider"; in v3 every provider
      // has one or more `providerId:N` keys, so map the legacy id to
      // chunk 0. The next refresh edits it in place — no extra post.
      out[`${k}:0`] = v;
    }
  }
  return out;
}

/**
 * Wrap a row block in Discord's monospace fence so the bar columns
 * line up. Truncate the tail rather than crashing if a single
 * provider's body somehow exceeds the 2000-char cap (shouldn't happen
 * with computeStatus's "skip unused models" guard, but defensive).
 */
function fence(rendered: string): string {
  const fenced = "```\n" + rendered + "\n```";
  if (fenced.length <= 2000) return fenced;
  const room = 2000 - "```\n\n…(truncated)\n```".length;
  return "```\n" + rendered.slice(0, room) + "\n…(truncated)\n```";
}

/**
 * Pack one provider's rows into Discord-message-sized chunks. Returns
 * an array of ready-to-send message bodies; one entry per chunk.
 *
 * Rows are rendered IN ONE PASS against the full set first, then split
 * by line, so the model-id column has a single consistent width across
 * every chunk for that provider. (Splitting first and rendering each
 * chunk independently would make column widths jump between chunks
 * whenever the longest id sat in a different chunk than the rest.)
 *
 * Hysteresis: when `previousCount` is provided (the chunk count from
 * last refresh), we prefer to stay at that count if possible, so a
 * provider whose row count hovers around a boundary doesn't flap
 * between 2 and 3 chunks across refreshes. We only grow when the new
 * content genuinely won't fit, and only shrink when it fits with room
 * to spare.
 */
function buildProviderChunks(
  providerId: string,
  rows: ModelStatus[],
  previousCount: number,
): string[] {
  // Content budget per chunk, leaving room for the ``` fences (8 chars
  // + 2 newlines) and a little slack for safety. Discord caps each
  // message at 2000 chars total.
  const CHUNK_BUDGET = 1900;
  // To shrink, the smaller layout has to fit with this much headroom.
  // Prevents 2↔3 chunk flapping when a provider sits right at the edge.
  const SHRINK_HEADROOM = 200;

  // Render against the full row set so column widths are consistent
  // across every chunk we produce below.
  const fullBody = renderRows(rows, /* stripPrefix */ true);
  if (!fullBody) return [];
  const lines = fullBody.split("\n");

  // Greedy pack: take rows in order, start a new chunk when adding the
  // next row would exceed CHUNK_BUDGET. Empty-chunk guard lets a single
  // pathologically long row land in its own chunk (the fence() call
  // below will still truncate it if it somehow exceeds 2000).
  const pack = (budget: number): string[][] => {
    const out: string[][] = [[]];
    let used = 0;
    for (const line of lines) {
      const cost = line.length + 1; // +1 newline
      const last = out[out.length - 1];
      if (used + cost > budget && last.length > 0) {
        out.push([]);
        used = 0;
      }
      out[out.length - 1].push(line);
      used += cost;
    }
    return out;
  };

  let packed = pack(CHUNK_BUDGET);

  // Hysteresis: if we used to have more chunks than we now need AND
  // the smaller fit isn't comfortable, repack at a tighter budget so
  // we stay at the previous count. Skipped when growing — running out
  // of room means we have to grow regardless.
  if (previousCount > packed.length && packed.length >= 1) {
    const tightestSingleChunkSize = Math.max(
      ...packed.map(
        (c) => c.reduce((n, l) => n + l.length + 1, 0),
      ),
    );
    if (tightestSingleChunkSize + SHRINK_HEADROOM > CHUNK_BUDGET) {
      // Smaller layout is too tight — stay at previousCount to avoid
      // flapping back next refresh.
      const targetBudget = Math.floor(
        lines.reduce((n, l) => n + l.length + 1, 0) / previousCount,
      ) + 50;
      const tryPack = pack(Math.min(CHUNK_BUDGET, targetBudget));
      if (tryPack.length === previousCount) packed = tryPack;
    }
  }

  const total = packed.length;
  return packed.map((chunkLines, i) => {
    const suffix = total > 1 ? ` (${i + 1}/${total})` : "";
    const header = `# ${providerId.toUpperCase()}${suffix}`;
    return `${header}\n${fence(chunkLines.join("\n"))}`;
  });
}

/**
 * How many chunks a provider had in the persisted map. Used so the
 * next refresh can keep the same chunk count when possible (avoiding
 * spammy posts/deletes if the row count hovers near a boundary).
 */
function chunkCountFor(map: MessageMap, providerId: string): number {
  let max = -1;
  for (const key of Object.keys(map)) {
    if (key === HEADER_KEY) continue;
    if (!key.startsWith(`${providerId}:`)) continue;
    const n = Number(key.slice(providerId.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Group statuses by their `pn`/`vx`/etc. provider id, preserving order within each. */
function groupByProvider(statuses: ModelStatus[]): Map<string, ModelStatus[]> {
  const groups = new Map<string, ModelStatus[]>();
  for (const s of statuses) {
    const slash = s.id.indexOf("/");
    // No slash = no prefix = misconfigured row. Bucket under "_unknown"
    // so it doesn't get silently dropped — but in practice the
    // computeStatus() filter rejects these earlier.
    const provider = slash >= 0 ? s.id.slice(0, slash) : "_unknown";
    const list = groups.get(provider);
    if (list) list.push(s);
    else groups.set(provider, [s]);
  }
  return groups;
}

/**
 * Public entry point. Cheap (cache + arithmetic) when throttled,
 * O(models) DB round-trips + (1 + providers) Discord HTTP calls when not.
 *
 * Never throws. Caller may use `.catch(() => {})` defensively but it's
 * not required — every internal failure is already swallowed.
 */
export async function refreshStatusBoard(): Promise<void> {
  try {
    if (!config.discordBotToken) return; // bot not configured at all

    const ac = await getAppConfig();
    if (!ac.discordStatusChannelId) return; // feature disabled

    // Claim the refresh window atomically BEFORE any work. This is the lock
    // that serializes refreshes across every isolate (see the Concurrency
    // note above) — winning it guarantees exactly one refresh per
    // THROTTLE_MS window, which is what stops the post/purge churn.
    if (!(await claimThrottleWindow("discord_status_last_edit_at", THROTTLE_MS))) {
      return;
    }

    // The claim invalidated this isolate's config cache, so re-read to get
    // the authoritative message-id map straight from the DB rather than a
    // possibly-stale cached copy — a stale map is what used to mislead
    // purgeStaleMessages into deleting still-valid messages.
    const fresh = await getAppConfig();

    const generatedAt = new Date();
    // includeUnused=false: drop models with zero requests so per-provider
    // messages don't fill with all-gray rows. HTTP /status keeps them.
    const statuses = await computeStatus(DISCORD_WINDOW, false);
    const groups = groupByProvider(statuses);
    const map = parseMessageMap(fresh.discordStatusMessageId);
    const channelId = fresh.discordStatusChannelId;

    let mapDirty = false;

    // Sweep stale messages: admin chatter (non-bot authors) AND any
    // bot-owned orphans whose id isn't tracked in our map. Orphans appear
    // when a previous refresh posted a new message but didn't persist the
    // new id (DB write failed, crash mid-deploy, etc.) — without this,
    // they sit in the channel forever because nothing else cleans them.
    // Same 5-min throttle as the rest of the refresh.
    await purgeStaleMessages(channelId, map);

    // Dashboard link banner FIRST so it lands at the top of the channel
    // (Discord shows oldest-posted at the top). Standalone message —
    // intentionally separate from the provider status messages and the
    // header — so users can click straight through to the public status
    // page without scrolling past the live model rows.
    const linkId = map[DASHBOARD_LINK_KEY];
    if (linkId) {
      const result = await editMessage(channelId, linkId, DASHBOARD_LINK_BODY);
      if (result === "missing" || result === "") {
        if (result === "") await deleteMessage(channelId, linkId);
        delete map[DASHBOARD_LINK_KEY];
        const newId = await postMessage(channelId, DASHBOARD_LINK_BODY);
        if (newId) {
          map[DASHBOARD_LINK_KEY] = newId;
          mapDirty = true;
        }
      }
    } else {
      const newId = await postMessage(channelId, DASHBOARD_LINK_BODY);
      if (newId) {
        map[DASHBOARD_LINK_KEY] = newId;
        mapDirty = true;
      }
    }

    // Process providers in alphabetical order so the visible top-to-
    // bottom layout stays stable run-to-run. (Within a provider, the
    // rows are already sorted by computeStatus: errors first.) Each
    // provider may render to MULTIPLE chunks if it has enough active
    // models to blow past Discord's 2000-char message cap; chunks are
    // keyed `providerId:N` in the map.
    const providerIds = Array.from(groups.keys()).sort();
    for (const providerId of providerIds) {
      const rows = groups.get(providerId)!;
      // Count the chunks we had last time so buildProviderChunks can
      // apply hysteresis and not flap between counts.
      const previousCount = chunkCountFor(map, providerId);
      const chunks = buildProviderChunks(providerId, rows, previousCount);

      // Edit-or-post each chunk we need now. Chunk 0 is the topmost,
      // chunk N-1 is the bottommost — Discord shows them in post order
      // so the first time a provider gains a second chunk, the second
      // chunk lands at the bottom of the channel (next to the header).
      for (let i = 0; i < chunks.length; i++) {
        const key = `${providerId}:${i}`;
        const body = chunks[i];
        const existingId = map[key];
        if (existingId) {
          const result = await editMessage(channelId, existingId, body);
          if (result === "missing" || result === "") {
            if (result === "") await deleteMessage(channelId, existingId);
            delete map[key];
            const newId = await postMessage(channelId, body);
            if (newId) {
              map[key] = newId;
              mapDirty = true;
            }
          }
        } else {
          const newId = await postMessage(channelId, body);
          if (newId) {
            map[key] = newId;
            mapDirty = true;
          }
        }
      }

      // Delete any chunks we no longer need (provider shrank since
      // last refresh). Deletes are silent — they don't bump the
      // channel or notify anyone — so a provider can go 3 → 2 chunks
      // without spam.
      for (const key of Object.keys(map)) {
        if (key === HEADER_KEY) continue;
        if (!key.startsWith(`${providerId}:`)) continue;
        const idxStr = key.slice(providerId.length + 1);
        const idx = Number(idxStr);
        if (!Number.isInteger(idx) || idx < chunks.length) continue;
        await deleteMessage(channelId, map[key]);
        delete map[key];
        mapDirty = true;
      }
    }

    // Sweep providers that disappeared from the catalog entirely —
    // admin disabled the whole provider, or every one of its models
    // dropped out of the visible window (includeUnused=false). Without
    // this, their old chunks would sit in the Discord channel
    // indefinitely AND keep growing the map. The per-provider loop
    // above only touches providers still present in `groups`, so it
    // can't catch this case on its own.
    const activeProviderIds = new Set(providerIds);
    const reservedKeys = new Set<string>([HEADER_KEY, DASHBOARD_LINK_KEY]);
    for (const key of Object.keys(map)) {
      if (reservedKeys.has(key)) continue;
      const colon = key.indexOf(":");
      if (colon < 0) continue; // shouldn't happen post-migration, but be defensive
      const providerId = key.slice(0, colon);
      if (activeProviderIds.has(providerId)) continue;
      await deleteMessage(channelId, map[key]);
      delete map[key];
      mapDirty = true;
    }

    // Header LAST so it lands at the bottom of the channel (Discord
    // shows newest-posted at the bottom). User explicitly chose this
    // order — they renamed the channel itself for the title, so the
    // bottom message is just `Updated <t:R>` and acts as a live
    // last-refreshed marker.
    //
    // Posted/edited even if no providers have data — gives the
    // operator a single anchor message that always exists once the
    // channel id is configured.
    const headerBody = renderHeader(generatedAt, /* discordTimestamp */ true);
    const headerId = map[HEADER_KEY];
    if (headerId) {
      const result = await editMessage(channelId, headerId, headerBody);
      if (result === "missing" || result === "") {
        if (result === "") await deleteMessage(channelId, headerId);
        delete map[HEADER_KEY];
        const newId = await postMessage(channelId, headerBody);
        if (newId) {
          map[HEADER_KEY] = newId;
          mapDirty = true;
        }
      }
    } else {
      const newId = await postMessage(channelId, headerBody);
      if (newId) {
        map[HEADER_KEY] = newId;
        mapDirty = true;
      }
    }

    if (mapDirty) {
      await setAppConfigKey("discord_status_message_id", JSON.stringify(map));
    }
    // Note: discord_status_last_edit_at is NOT written here — claimThrottleWindow
    // already advanced it at the start of the refresh. Writing it again at the
    // end would just move the window's start later for no benefit.
  } catch (err) {
    console.error("[discord-status] refresh failed:", (err as Error).message);
  }
}

/**
 * List recent messages in the channel and delete two kinds of stale rows:
 *   1. Messages from someone other than the bot (admin chatter in a
 *      channel meant to be bot-only).
 *   2. Bot-owned messages whose id is NOT in our tracked `map`. These
 *      are orphans from a previous partial failure — e.g. we posted a
 *      replacement on edit failure but the prior `deleteMessage` for
 *      the old message itself failed, leaving a permanent duplicate.
 *      Nothing else cleans these up, so the channel grew "two Updated
 *      ... ago" entries over time until this purge was added.
 *
 * For slash-command/bot applications, the Discord app id (config.discordAppId)
 * is the same as the bot's user id, so author.id === discordAppId identifies
 * our own posts. If discordAppId isn't configured we skip the purge entirely
 * rather than risk deleting our own messages.
 *
 * Pulls up to 100 messages in one call (Discord's per-request cap). At 5-min
 * throttle that's plenty of headroom for any realistic admin-typing rate;
 * if more than 100 accumulate between refreshes the next refresh sweeps
 * the next batch.
 *
 * Best-effort: every error is logged and swallowed. The next refresh tries
 * again.
 */
async function purgeStaleMessages(
  channelId: string,
  map: MessageMap,
): Promise<void> {
  if (!config.discordAppId) return;
  try {
    const res = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages?limit=100`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[discord-status] purge list ${res.status}: ${text.slice(0, 200)}`,
      );
      return;
    }
    const messages = (await res.json().catch(() => null)) as
      | Array<{ id?: string; author?: { id?: string } }>
      | null;
    if (!Array.isArray(messages)) return;

    // Every message id we currently track. Anything in the channel that
    // ISN'T in this set is either an admin's chatter (non-bot author)
    // or a bot-owned orphan from a previous partial failure (crash mid-
    // deploy, edit-failure repost where the old delete itself failed,
    // etc.). Both should go.
    const trackedIds = new Set(Object.values(map));

    for (const m of messages) {
      const id = m?.id;
      const authorId = m?.author?.id;
      if (!id || !authorId) continue;
      if (authorId === config.discordAppId && trackedIds.has(id)) continue;
      await deleteMessage(channelId, id);
    }
  } catch (err) {
    console.error(
      "[discord-status] purge exception:",
      (err as Error).message,
    );
  }
}

/**
 * POST a new message to the channel. Returns the new message id on
 * success, "" on any failure (logged).
 */
async function postMessage(channelId: string, content: string): Promise<string> {
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[discord-status] post ${res.status}: ${text.slice(0, 200)}`,
      );
      return "";
    }
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    return json?.id ?? "";
  } catch (err) {
    console.error("[discord-status] post exception:", (err as Error).message);
    return "";
  }
}

/**
 * DELETE a message. Discord doesn't notify or bump the channel for
 * deletes, so this is the "silent" cleanup primitive for orphan chunks
 * when a provider shrinks. 404 is fine — already gone, treat as
 * success.
 */
async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  try {
    const res = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bot ${config.discordBotToken}` },
      },
    );
    if (res.ok || res.status === 404) {
      console.log(`[discord-status] deleted message ${messageId}`);
    } else {
      const text = await res.text().catch(() => "");
      console.error(
        `[discord-status] delete ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error("[discord-status] delete exception:", (err as Error).message);
  }
}

/**
 * PATCH an existing message. Returns "ok" on success, "missing" if
 * Discord 404'd (message was deleted manually), "" on any other failure.
 */
async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
): Promise<"ok" | "missing" | ""> {
  try {
    const res = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
    );
    if (res.status === 404) return "missing";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[discord-status] edit ${res.status}: ${text.slice(0, 200)}`,
      );
      return "";
    }
    return "ok";
  } catch (err) {
    console.error("[discord-status] edit exception:", (err as Error).message);
    return "";
  }
}
