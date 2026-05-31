/**
 * Live model-health status.
 *
 * For every enabled model the proxy currently exposes (same set
 * /v1/models would return, minus mock/), reads the last 20 rows from
 * request_logs and maps each one to a colored bar:
 *
 *   green   = status 200 AND duration_ms ≤ SLOW_THRESHOLD_MS
 *   yellow  = status 200 AND duration_ms >  SLOW_THRESHOLD_MS  (slow but worked)
 *   red     = status >= 400                                    (error)
 *   missing = no row at that slot (model has fewer than 20 calls on record)
 *
 * Two consumers:
 *   - routes/status.ts  → public GET /status (JSON or ?format=text)
 *   - lib/discord-status.ts → the live board edited in a Discord channel
 *
 * Both render off renderText(); rendering lives here so the board and
 * the HTTP route can never drift.
 *
 * Why per-model and not per-provider: a provider can have many models
 * with very different upstream behaviour (a tiny chat model vs a
 * reasoning model). One row per model gives users actionable signal —
 * "pn/gpt-5 is red but pn/gpt-4 is green" tells them which model to
 * pick right now. Per-provider would average these out.
 */

import { getDb, hasDb } from "./db.js";
import { aggregateModels, publicModelId } from "../routes/models.js";
import { prefixToProviderId } from "../providers/registry.js";

/** A 200-status request slower than this counts as "slow but worked" (yellow). */
export const SLOW_THRESHOLD_MS = 30_000;

/** Default window: how many trailing requests we consider per model. */
export const DEFAULT_WINDOW = 20;

/**
 * Discord-specific window. The board lives in a single ~2000-char
 * message and gets crowded fast — emoji squares are wider than a
 * monospace cell, so 20 squares × 30 models eats the whole budget.
 * 8 is a comfortable middle ground: enough history to spot a trend
 * (3-4 reds in a row vs an isolated blip) without crowding the row.
 */
export const DISCORD_WINDOW = 8;

/**
 * /health slash-command window. Even tighter than the board because
 * it's an ephemeral on-demand reply, not a passive monitor — users
 * just want a quick "is it working right now?" signal, and 5 squares
 * fits comfortably even when several models are listed.
 */
export const HEALTH_WINDOW = 5;

export type BarColor = "green" | "yellow" | "red";

export type Bar = {
  color: BarColor;
  status: number;
  durationMs: number;
  /** ISO timestamp from request_logs.created_at */
  at: string;
};

export type ModelStatus = {
  /** Public id, e.g. "pn/gpt-4" or "or/llama-3-70b". This is what users type. */
  id: string;
  /** Vendor label (openai/anthropic/google/…). Admin-internal id never leaks. */
  ownedBy: string;
  /** Window size used for this snapshot — bars.length + summary.missing always equals this. */
  window: number;
  /** Newest → oldest. Length is 0..window; missing slots are not represented here. */
  bars: Bar[];
  summary: {
    ok: number;
    slow: number;
    error: number;
    /** window - bars.length. Unused capacity, rendered as gray squares. */
    missing: number;
  };
};

function colorFor(status: number, durationMs: number): BarColor {
  if (status >= 400) return "red";
  if (status === 200 && durationMs > SLOW_THRESHOLD_MS) return "yellow";
  // Anything 2xx/3xx within budget is green. Treat unexpected non-error
  // statuses (e.g. 204) the same as 200 — they didn't fail the request.
  return "green";
}

/**
 * Pull the trailing `window` rows for one model. Returns newest → oldest.
 * Empty array on any DB miss / no-supabase environment.
 *
 * Matching is by **provider + bare model id**, not by exact `model`
 * column equality. The `model` column logs the user's raw input string
 * verbatim (chat.ts:307), which can be any of these for one logical
 * upstream call:
 *   - the prefixed canonical id      "pn/claude-opus-4-7"
 *   - the bare id (legacy)           "claude-opus-4-7"
 *   - a different prefix the user
 *     typed by mistake               "xx/claude-opus-4-7"
 *
 * What identifies the row unambiguously is the resolved provider, which
 * we already log to `via`. So we filter `via = providerId` first (cheap,
 * indexed) and then accept any `model` value whose tail matches the
 * bare id. That keeps historical rows visible without a backfill, and
 * still attributes each row to the right model — `via` was set by the
 * registry after resolveModel() ran, so it's the source of truth for
 * "which model actually ran upstream".
 *
 * As of the warming-logs feature, the strip blends rows from BOTH
 * `request_logs` (real user traffic) and `warming_logs` (synthetic
 * upstream calls fired by lib/warmer.ts). We pull `window`-sized pages
 * from each, merge by `created_at desc`, and take the newest `window`.
 * From the strip's perspective a warm row and a real row are
 * indistinguishable — both represent "an upstream call landed at this
 * timestamp with this status and duration." Warm rows naturally age
 * out as real traffic displaces them, and the periodic prune in
 * lib/warmer.ts:maybePrune deletes any warm rows that have already
 * fallen out of the visible window.
 */
/**
 * Batched per-provider bar loader.
 *
 * Returns a map from bare-model id ("claude-opus-4-7") to its window of
 * Bar entries, newest-first. ONE pair of queries per provider — the
 * window function does the per-model top-N grouping inside Postgres, so
 * we don't have to fire one query per model.
 *
 * Before this refactor computeStatus called loadBars(model) inside a
 * Promise.all over every visible model — 2 queries × ~400 models = 800+
 * concurrent statements, all funneling through the postgres pool's max:5.
 * On Cloudflare that blew the 50-subrequest cap entirely; on Vercel it
 * serialized into ~20-second wall-clock responses on /api/status. Now
 * the catalog-wide fan-out is just 2 × (number of providers) ≈ 30-40
 * queries total, comfortably under any cap and fast on either host.
 *
 * `regexp_replace(model, '^[^/]+/', '')` strips any provider prefix on
 * the `model` column so the per-(provider, bare-model) partition lines
 * up regardless of how the user typed the model — the old code's
 * `model = bareId OR model = publicId OR model LIKE '%/bareId'` is
 * exactly what this regex collapses to.
 */
async function loadBarsByProvider(
  providerId: string,
  window: number,
): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  if (!hasDb()) return out;
  const sql = getDb();
  type Row = {
    bare_model: string;
    status: number;
    duration_ms: number;
    created_at: string;
  };
  let reqRows: Row[] = [];
  let warmRows: Row[] = [];
  try {
    [reqRows, warmRows] = await Promise.all([
      sql<Row[]>`
        select bare_model, status, duration_ms, created_at
        from (
          select
            regexp_replace(coalesce(model, ''), '^[^/]+/', '') as bare_model,
            status, duration_ms, created_at,
            row_number() over (
              partition by regexp_replace(coalesce(model, ''), '^[^/]+/', '')
              order by created_at desc
            ) as rn
          from request_logs
          where via = ${providerId} and model is not null
        ) t
        where rn <= ${window}
      `,
      sql<Row[]>`
        select bare_model, status, duration_ms, created_at
        from (
          select
            regexp_replace(coalesce(model, ''), '^[^/]+/', '') as bare_model,
            status, duration_ms, created_at,
            row_number() over (
              partition by model
              order by created_at desc
            ) as rn
          from warming_logs
          where via = ${providerId} and model is not null
        ) t
        where rn <= ${window}
      `,
    ]);
  } catch (err) {
    console.error(
      `[status] batched load for ${providerId} failed:`,
      (err as Error).message,
    );
    return out;
  }

  // Group merged rows by bare_model, sort newest-first, trim to window.
  const buckets = new Map<string, Row[]>();
  for (const r of reqRows) {
    if (!r.bare_model) continue;
    (buckets.get(r.bare_model) ?? buckets.set(r.bare_model, []).get(r.bare_model)!).push(r);
  }
  for (const r of warmRows) {
    if (!r.bare_model) continue;
    (buckets.get(r.bare_model) ?? buckets.set(r.bare_model, []).get(r.bare_model)!).push(r);
  }
  for (const [bareModel, rows] of buckets) {
    rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    out.set(
      bareModel,
      rows.slice(0, window).map((r) => ({
        color: colorFor(r.status, r.duration_ms ?? 0),
        status: r.status,
        durationMs: r.duration_ms ?? 0,
        at: r.created_at,
      })),
    );
  }
  return out;
}

function summarize(bars: Bar[], window: number): ModelStatus["summary"] {
  let ok = 0;
  let slow = 0;
  let error = 0;
  for (const b of bars) {
    if (b.color === "green") ok++;
    else if (b.color === "yellow") slow++;
    else error++;
  }
  return { ok, slow, error, missing: window - bars.length };
}

/**
 * Build the full status snapshot. One DB round-trip per enabled model
 * (typical setup ≤30 models, all on the same Postgres pooler) is fine
 * and keeps the per-model query trivially indexable.
 *
 * Mock models are excluded — they're the in-process testing provider
 * and have no operational signal worth showing.
 *
 * `window` controls the strip length. Defaults to DEFAULT_WINDOW (20)
 * for the HTTP route; the Discord board passes DISCORD_WINDOW (5) so
 * the message stays under Discord's 2000-char ceiling.
 *
 * `includeUnused` controls whether models with zero recorded requests
 * appear in the result. The HTTP route keeps them (true) so admins can
 * confirm at a glance that a model is exposed but cold; the Discord
 * board drops them (false) because the 2000-char cap is real and a wall
 * of all-gray rows pushes the actually-actionable signal off the
 * bottom — the user complained the board was getting truncated by
 * dozens of unused models.
 */
/**
 * In-process cache for computeStatus results.
 *
 * Why: computeStatus fans out into 2 DB queries per visible model
 * (one per request_logs / warming_logs lookup) via Promise.all. With
 * ~16 providers × dozens of models each, that's hundreds of parallel
 * queries — all of which then funnel through the postgres pool's max
 * (5 on Cloudflare via Hyperdrive). The result: a cold /api/status
 * call serializes ~80 rounds × ~100ms each = ~10-25 seconds wall
 * clock. The dashboard and the Discord status board both hit this
 * route every refresh / every few seconds, so the cost compounds fast.
 *
 * 15s is short enough that the strip still feels live and long enough
 * to absorb a burst of dashboard refreshes and back-to-back Discord
 * board edits without recomputing. Cache key includes both kwargs
 * because the Discord board calls with smaller windows than the HTTP
 * route.
 */
const CACHE_TTL_MS = 15_000;
type CacheEntry = {
  generatedAt: number;
  data: ModelStatus[];
  window: number;
  includeUnused: boolean;
};
let statusCache: CacheEntry | null = null;

/** Drop the cached snapshot. Call after any write that affects status
 *  shape (provider enabled/disabled, model masked, etc.) so the next
 *  read recomputes immediately instead of waiting out the TTL. */
export function invalidateStatusCache(): void {
  statusCache = null;
}

export async function computeStatus(
  window: number = DEFAULT_WINDOW,
  includeUnused: boolean = true,
): Promise<ModelStatus[]> {
  const now = Date.now();
  if (
    statusCache &&
    statusCache.window === window &&
    statusCache.includeUnused === includeUnused &&
    now - statusCache.generatedAt < CACHE_TTL_MS
  ) {
    return statusCache.data;
  }

  // aggregateModels() warms the provider registry snapshot; prefixMap then
  // reads that same cached snapshot, so this is not an extra DB round-trip.
  const [all, prefixMap] = await Promise.all([
    aggregateModels(),
    prefixToProviderId(),
  ]);
  const visible = all.filter((m) => !m.id.startsWith("mock/"));

  // Split each visible model into (publicId, prefix, viaId, bareId) once.
  // Done up front so we can build the set of unique `via` ids we need to
  // fetch bars for, and then iterate the same list to assemble the final
  // result without re-parsing ids.
  //
  // `viaId` is the crucial bit: request_logs.via stores the provider's
  // stable internal id, which can DIFFER from the user-facing prefix in
  // the model id (e.g. prefix 'or' but id 'openrouter', after a prefix rename).
  // We translate prefix → id through the registry so the log lookup
  // matches; if there's no mapping we fall back to the prefix itself,
  // which keeps every prefix==id provider working exactly as before.
  type Key = { id: string; viaId: string; bareId: string; ownedBy: string };
  const keys: Key[] = visible.map((m) => {
    const id = publicModelId(m.id);
    const slash = id.indexOf("/");
    const prefix = slash >= 0 ? id.slice(0, slash) : "";
    return {
      id,
      viaId: prefix ? (prefixMap.get(prefix.toLowerCase()) ?? prefix) : "",
      bareId: slash >= 0 ? id.slice(slash + 1) : id,
      ownedBy: m.owned_by,
    };
  });

  // ONE pair of queries per unique provider, not per model. Was the
  // root cause of /api/status taking 20+ seconds: the previous
  // Promise.all(visible.map(loadBars)) fired 2 × ~400 queries. Keyed by
  // the via id (= request_logs.via) so the filter inside
  // loadBarsByProvider matches the logged rows.
  const uniqueViaIds = [...new Set(keys.map((k) => k.viaId).filter(Boolean))];
  const barsByViaId = new Map<string, Map<string, Bar[]>>();
  await Promise.all(
    uniqueViaIds.map(async (viaId) => {
      barsByViaId.set(viaId, await loadBarsByProvider(viaId, window));
    }),
  );

  const statuses: ModelStatus[] = keys.map((k) => {
    const bars = k.viaId
      ? barsByViaId.get(k.viaId)?.get(k.bareId) ?? []
      : [];
    return {
      id: k.id,
      ownedBy: k.ownedBy,
      window,
      bars,
      summary: summarize(bars, window),
    } satisfies ModelStatus;
  });

  const filtered = includeUnused
    ? statuses
    : statuses.filter((s) => s.bars.length > 0);

  // Sort: errored models first (most actionable), then slow, then by id
  // for stable ordering within a tier.
  filtered.sort((a, b) => {
    if (a.summary.error !== b.summary.error) return b.summary.error - a.summary.error;
    if (a.summary.slow !== b.summary.slow) return b.summary.slow - a.summary.slow;
    return a.id.localeCompare(b.id);
  });

  statusCache = { generatedAt: now, data: filtered, window, includeUnused };
  return filtered;
}

// ─── Rendering ─────────────────────────────────────────────────────────

const GREEN = "🟢";
const YELLOW = "🟡";
const RED = "🔴";
// Black large square (U+2B1B). Was ⚪ (white circle) — wrong on two
// counts: Discord renders it as a bright white circle on dark themes
// (visually loud and looks like a "no signal" emergency), and it's a
// circle while the colored cells are squares (mismatched shape made
// the strip read like four separate symbol categories instead of "data
// vs no-data"). The black square is quiet AND shape-consistent.
const EMPTY = "⬛";

function renderBars(s: ModelStatus): string {
  const cells: string[] = [];
  // Pad EMPTY at the FRONT so the strip is right-aligned: real bars
  // hug the right edge (newest=now=rightmost), and missing slots fill
  // in from the left. Without this the real bars sat on the LEFT and
  // the EMPTYs trailed off to the right, which contradicted the
  // "right is now" reading direction every other surface uses.
  const missing = s.window - s.bars.length;
  for (let i = 0; i < missing; i++) cells.push(EMPTY);
  // bars[] comes from loadBars() newest-first. Iterate in reverse so
  // we render oldest → newest left-to-right (matching status.claude.com
  // and the visual /status page, which already does this via its
  // own slots-from-the-right rendering).
  for (let i = s.bars.length - 1; i >= 0; i--) {
    const b = s.bars[i];
    cells.push(b.color === "green" ? GREEN : b.color === "yellow" ? YELLOW : RED);
  }
  return cells.join("");
}

/**
 * Plain-text rendering used by GET /status?format=text. The Discord
 * board composes its messages from `renderHeader` + `renderRows`
 * directly — see lib/discord-status.ts.
 *
 * Pads model ids to a constant width so the bar columns line up — relies
 * on a monospaced container (curl, ``` code blocks). Discord renders
 * these emoji at a slightly wider glyph than ASCII space, so columns
 * past the bars won't perfectly align in the Discord client; the model
 * id column does, which is what people actually scan for.
 */
export function renderText(
  statuses: ModelStatus[],
  generatedAt: Date = new Date(),
): string {
  if (statuses.length === 0) {
    return renderHeader(generatedAt) + "\n\nNo models enabled right meow~";
  }
  return renderHeader(generatedAt) + "\n\n" + renderRows(statuses);
}

/**
 * Header used by both the HTTP route and the Discord status board.
 *
 * Just `Updated <stamp>`. The board's channel is dedicated to status
 * (the user named it accordingly), so the redundant title would just
 * be visual noise — and the HTTP route's caller already knows which
 * service is talking to them.
 *
 * `discordTimestamp=true` swaps the ISO timestamp for Discord's relative
 * `<t:UNIX:R>` tag, which renders client-side as "just now" → "30
 * seconds ago" → "5 minutes ago" and updates automatically without us
 * editing the message. HTTP path keeps the ISO so curl / uptime
 * monitors stay machine-friendly.
 */
export function renderHeader(
  generatedAt: Date,
  discordTimestamp: boolean = false,
): string {
  const stamp = discordTimestamp
    ? `<t:${Math.floor(generatedAt.getTime() / 1000)}:R>`
    : generatedAt.toISOString();
  return `Updated ${stamp}`;
}

/**
 * Render the rows-only block (no title, no timestamp). Shared between
 * the HTTP route and per-provider Discord messages so a row never
 * formats two different ways.
 *
 * Width-pads model ids based ONLY on the rows passed in, so a Discord
 * per-provider message gets its own tight column — `pn/...` rows
 * don't get padded out to the width of the longest `vx/...` id when
 * those live in a different message.
 *
 * Just the model id and the colored squares. No `5 ok · 2 slow · 1 err`
 * suffix — the squares already convey color, and a textual count next
 * to a visual count is just noise.
 *
 * `stripPrefix=true` drops the `pn/`, `vx/`, etc. routing prefix from
 * each row. Used by the per-provider Discord messages where the
 * prefix is already implied by the message's `# PN` / `# VX` header,
 * so repeating it on every row is just visual noise. The HTTP /status
 * route keeps prefixes (default false) so the dump stays self-
 * contained for grep/scripting.
 */
export function renderRows(
  statuses: ModelStatus[],
  stripPrefix: boolean = false,
): string {
  if (statuses.length === 0) return "";
  const ids = statuses.map((s) => {
    if (!stripPrefix) return s.id;
    const slash = s.id.indexOf("/");
    return slash >= 0 ? s.id.slice(slash + 1) : s.id;
  });
  const idWidth = Math.max(...ids.map((id) => id.length));
  return statuses
    .map((s, i) => `${ids[i].padEnd(idWidth)}  ${renderBars(s)}`)
    .join("\n");
}
