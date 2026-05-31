/**
 * Synthetic chat-completion driver that fills /status strips for cold
 * models without depending on real users typing into them.
 *
 * Two functions:
 *   - maybeWarm()   "If the warmer hasn't run in 30 min, pick the
 *                    coldest enabled model and fire one tiny chat
 *                    completion against it. Log the result to
 *                    warming_logs."
 *   - maybePrune()  "If the pruner hasn't run in 30 min, ask Postgres
 *                    to drop any warming_logs rows that have been
 *                    displaced from the visible top-20 by real
 *                    request_logs traffic."
 *
 * Both:
 *   - Throttled to 30 minutes via timestamps in app_config
 *     (warm_last_run_at / prune_last_run_at). Two independent clocks.
 *   - Triggered fire-and-forget by chat.ts after every appendLog. The
 *     throttle check is a single cached getAppConfig() lookup +
 *     arithmetic, so 99 % of calls return immediately.
 *   - Never throw. Failures are logged to console and swallowed; chat
 *     traffic must NEVER fail because warming threw.
 *
 * Why piggyback on chat traffic instead of running on a schedule:
 * Vercel Hobby cron is once-a-day max, and the project doesn't want
 * a separate always-on host. Real chat traffic IS the trigger — we
 * just hitch a ride.
 *
 * Why NOT through HTTP /v1/chat/completions: that would spawn a second
 * Vercel function invocation (cost) AND require a synthetic API key
 * for auth. We're already inside the same Node process that handled
 * the user's request, and we already have the registry + supabase
 * client warm in memory. Direct in-process call to provider.chat() is
 * the right tool.
 *
 * Concurrency: two parallel chat requests can both pass the 30-min
 * throttle check in the few ms before either persists the new
 * warm_last_run_at. The cost is at most one redundant warm call per
 * window (= one tiny extra upstream call). Not worth a distributed
 * lock; same posture as lib/discord-status.ts.
 */

import { getDb, hasDb } from "./db.js";
import { getAppConfig, setAppConfigKey } from "./app-config.js";
import { aggregateModels, publicModelId } from "../routes/models.js";
import { resolveModel } from "../providers/registry.js";
import {
  ProviderError,
  type ChatRequest,
  type ProviderMeta,
} from "../providers/types.js";

/**
 * Minimum interval between successful warmer runs.
 *
 * Tuned LOWER than COLDNESS_WINDOW_MS on purpose. The throttle controls
 * how often a warm CAN fire (one every 5 min, when piggybacking real
 * traffic); the coldness window controls how long a model stays
 * "warm" in our memory. With 5 min throttle + 30 min coldness window,
 * a single 30-min span can spread warming across ~6 different cold
 * models instead of repeatedly re-picking whichever one wins the
 * alphabetical tiebreaker the moment its previous warm row ages out.
 *
 * Previous setting was 30 min == coldness window, which produced a
 * pathological "same model gets warmed every cycle" loop: the row
 * written by the previous warm aged out of the coldness window at
 * exactly the same instant the throttle released, so the just-warmed
 * model was indistinguishable from a never-warmed one on the next
 * tick. See git history for the real-world cobuddy:free streak.
 */
const WARM_THROTTLE_MS = 5 * 60 * 1000;
/** Minimum interval between successful pruner runs. */
const PRUNE_THROTTLE_MS = 30 * 60 * 1000;

/**
 * "Cold enough to warm" means no row in either table within the last
 * COLDNESS_WINDOW_MS. Any model that's been called organically
 * (real or synthetic) within that window is left alone.
 *
 * Must be STRICTLY greater than WARM_THROTTLE_MS so a just-warmed
 * model is still remembered as warm when the throttle next releases.
 * 30 min is comfortable: covers ~6 throttle cycles, so the warmer
 * cycles through cold models before re-picking any.
 */
const COLDNESS_WINDOW_MS = 30 * 60 * 1000;

// ─── Public entry points ──────────────────────────────────────────────

/**
 * Pick the coldest enabled model and fire one synthetic chat to warm it.
 * Returns immediately when throttled (the common case).
 *
 * Never throws. Caller may use `.catch(() => {})` defensively but it's
 * not required — every internal failure is already swallowed.
 */
export async function maybeWarm(): Promise<void> {
  try {
    if (!hasDb()) return;

    const ac = await getAppConfig();
    if (isThrottled(ac.warmLastRunAt, WARM_THROTTLE_MS)) return;

    const target = await pickColdestModel();
    if (!target) return; // every model has been touched within the window

    await runSyntheticChat(target);
    await setAppConfigKey("warm_last_run_at", new Date().toISOString());
  } catch (err) {
    console.error("[warmer] maybeWarm failed:", (err as Error).message);
  }
}

/**
 * Drop warming rows that have fallen out of the top-20 visible window
 * for their model (because real request_logs rows displaced them).
 * Throttled to once per 30 min like the warmer; same fire-and-forget
 * never-throws contract.
 *
 * The actual delete happens in a Postgres function (prune_warming_logs)
 * defined in scripts/migrate.ts — keeps the partition-by-model logic
 * server-side where it belongs and atomic.
 */
export async function maybePrune(): Promise<void> {
  try {
    if (!hasDb()) return;

    const ac = await getAppConfig();
    if (isThrottled(ac.pruneLastRunAt, PRUNE_THROTTLE_MS)) return;

    const sql = getDb();
    try {
      await sql`select prune_warming_logs()`;
    } catch (err) {
      console.error("[warmer] prune rpc failed:", (err as Error).message);
      return;
    }
    await setAppConfigKey("prune_last_run_at", new Date().toISOString());
  } catch (err) {
    console.error("[warmer] maybePrune failed:", (err as Error).message);
  }
}

// ─── Internals ────────────────────────────────────────────────────────

function isThrottled(lastRunIso: string, ttlMs: number): boolean {
  if (!lastRunIso) return false; // never run → not throttled
  const last = Date.parse(lastRunIso);
  if (!Number.isFinite(last)) return false; // garbage value → not throttled
  return Date.now() - last < ttlMs;
}

/**
 * Find the enabled model whose most-recent row across BOTH request_logs
 * and warming_logs is the oldest, or that has no rows at all. Returns
 * null when every enabled model has been touched within the last
 * COLDNESS_WINDOW_MS — meaning the proxy is already warming itself.
 *
 * One Supabase round-trip per side: pull latest-N rows from each table
 * and reduce to a per-model "newest row" map. N is bounded by the
 * model count × WINDOW; the indexes already exist (model + created_at).
 */
async function pickColdestModel(): Promise<{
  publicId: string;
  bareId: string;
  providerId: string;
} | null> {
  const sql = getDb();

  // Catalog: every enabled model on every enabled provider, mock excluded.
  const all = await aggregateModels();
  const visible = all.filter((m) => !m.id.startsWith("mock/"));
  if (visible.length === 0) return null;

  // Build a lookup of each catalog model's pieces.
  type Candidate = { publicId: string; bareId: string; providerId: string };
  const candidates: Candidate[] = visible
    .map((m) => {
      const id = publicModelId(m.id);
      const slash = id.indexOf("/");
      if (slash < 0) return null;
      return {
        publicId: id,
        providerId: id.slice(0, slash),
        bareId: id.slice(slash + 1),
      } satisfies Candidate;
    })
    .filter((c): c is Candidate => c !== null);

  // newestPerModel keyed by publicId; missing key = no rows at all.
  const newest = new Map<string, number>();

  const sinceIso = new Date(Date.now() - COLDNESS_WINDOW_MS).toISOString();
  const providerIds = Array.from(new Set(candidates.map((c) => c.providerId)));

  type ReqRow = { via: string; model: string; created_at: string };
  type WarmRow = { model: string; created_at: string };
  let realRows: ReqRow[] = [];
  let warmRows: WarmRow[] = [];
  try {
    [realRows, warmRows] = await Promise.all([
      sql<ReqRow[]>`
        select via, model, created_at
        from request_logs
        where via in ${sql(providerIds)}
          and created_at >= ${sinceIso}
          and model is not null
      `,
      sql<WarmRow[]>`
        select model, created_at
        from warming_logs
        where created_at >= ${sinceIso}
      `,
    ]);
  } catch (err) {
    console.error("[warmer] pickColdestModel read failed:", (err as Error).message);
    return null;
  }

  for (const r of realRows) {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at)) continue;
    for (const c of candidates) {
      if (c.providerId !== r.via) continue;
      if (
        r.model === c.bareId ||
        r.model === c.publicId ||
        r.model.endsWith("/" + c.bareId)
      ) {
        const cur = newest.get(c.publicId) ?? 0;
        if (at > cur) newest.set(c.publicId, at);
      }
    }
  }

  for (const r of warmRows) {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at)) continue;
    const cur = newest.get(r.model) ?? 0;
    if (at > cur) newest.set(r.model, at);
  }

  // Filter to candidates whose newest row is older than the window
  // boundary, OR who have no newest row at all (= zero rows in window).
  const cutoff = Date.now() - COLDNESS_WINDOW_MS;
  const eligible = candidates.filter((c) => {
    const at = newest.get(c.publicId);
    return at === undefined || at <= cutoff;
  });
  if (eligible.length === 0) return null;

  // Pick the coldest: zero-row candidates first (they go alphabetically
  // among themselves so order is deterministic), otherwise oldest
  // newest-row first.
  eligible.sort((a, b) => {
    const aAt = newest.get(a.publicId);
    const bAt = newest.get(b.publicId);
    if (aAt === undefined && bAt === undefined)
      return a.publicId.localeCompare(b.publicId);
    if (aAt === undefined) return -1;
    if (bAt === undefined) return 1;
    if (aAt !== bAt) return aAt - bAt;
    return a.publicId.localeCompare(b.publicId);
  });

  return eligible[0];
}

/**
 * Resolve the chosen model and fire one direct provider.chat() with a
 * 1-token "hi" / 8-token cap. Inserts a warming_logs row for either
 * outcome (success status, or upstream-error status) so failed
 * warm calls show up as red squares — that's a real signal that the
 * model is broken right now.
 */
async function runSyntheticChat(target: {
  publicId: string;
  bareId: string;
  providerId: string;
}): Promise<void> {
  let resolution;
  try {
    resolution = await resolveModel(target.publicId);
  } catch (err) {
    // Model couldn't be routed (provider gone, prefix changed, etc.).
    // Don't blow up the warmer — just log and skip. Next tick will
    // pick a different cold model.
    console.error(
      `[warmer] resolveModel(${target.publicId}) failed:`,
      (err as Error).message,
    );
    return;
  }
  const { provider, upstreamId } = resolution;

  const req: ChatRequest = {
    model: upstreamId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
    stream: false,
  };
  const meta: ProviderMeta = {};

  const start = Date.now();
  let status = 200;
  let errorMessage: string | undefined;
  try {
    await provider.chat(req, meta);
  } catch (err) {
    if (err instanceof ProviderError) {
      status = err.status;
    } else {
      status = 500;
    }
    errorMessage = (err as Error).message?.slice(0, 500);
  }
  const durationMs = Date.now() - start;

  // Insert directly — we deliberately don't reuse appendLog() because
  // that writes to request_logs. Different table, different shape.
  const sql = getDb();
  try {
    await sql`
      insert into warming_logs (model, via, status, duration_ms, error)
      values (${target.publicId}, ${target.providerId}, ${status}, ${durationMs}, ${errorMessage ?? null})
    `;
  } catch (err) {
    console.error(
      `[warmer] insert warming_logs(${target.publicId}) failed:`,
      (err as Error).message,
    );
  }
}
