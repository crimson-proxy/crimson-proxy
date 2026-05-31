/**
 * Runtime-agnostic "keep this promise alive past the HTTP response."
 *
 * Used by Discord's deferred-response pattern (routes/discord.ts): the
 * handler returns `{type: 5}` to satisfy Discord's 3s deadline, then a
 * background task does the real DB work and PATCHes the followup webhook.
 * For that pattern to survive on serverless, the work has to be handed
 * to the platform's waitUntil so the function isn't killed when the
 * response goes out.
 *
 * Three runtimes, three behaviors:
 *
 *   Cloudflare Workers
 *     The entry adapter (src/entry/cloudflare.ts) passes `ctx` to
 *     `app.fetch(req, env, ctx)`; Hono exposes it as `c.executionCtx`.
 *     We call `c.executionCtx.waitUntil(...)`.
 *
 *   Vercel (Node serverless)
 *     Vercel's runtime exposes a request context via
 *     `globalThis[Symbol.for("@vercel/request-context")]`. Calling
 *     `.get().waitUntil(promise)` on it tells the runtime to keep the
 *     invocation alive until the promise settles. We read it directly
 *     instead of importing `@vercel/functions`, so this file bundles on
 *     Cloudflare without an extra dependency.
 *
 *   Long-running Node (npm run start:server)
 *     No ceremony needed — the process stays alive, the promise just
 *     resolves whenever. We attach a `.catch` to swallow rejections so
 *     a background failure doesn't surface as an unhandled rejection.
 *
 * Failures inside the background task are logged and swallowed on every
 * runtime: by the time we're running, the user has already seen
 * "thinking..." in Discord — the worst case is that the followup PATCH
 * never lands and Discord shows the spinner until the 15-minute
 * interaction-token expiry. That's better than crashing the runtime.
 */

import type { Context } from "hono";

type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * Pull Vercel's per-invocation context off globalThis, if it exists.
 * Returns undefined on every other runtime.
 */
function vercelRequestContext(): { waitUntil?: WaitUntilFn } | undefined {
  try {
    const holder = (globalThis as unknown as Record<symbol, { get?: () => unknown } | undefined>)[
      Symbol.for("@vercel/request-context")
    ];
    return holder?.get?.() as { waitUntil?: WaitUntilFn } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Schedule `work` to keep running after the current HTTP response goes
 * out. Picks the right mechanism for the runtime; on Node it's a no-op
 * beyond attaching an error handler.
 */
export function runInBackground(c: Context, work: Promise<unknown>): void {
  // Always attach a catch — keeps the runtime quiet if the task rejects.
  const safe = work.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[background] task failed:", msg);
  });

  // Cloudflare: c.executionCtx is a getter that throws when not set
  // (Vercel/Node entries don't pass a ctx through), so guard with try.
  try {
    c.executionCtx.waitUntil(safe);
    return;
  } catch {
    // fall through
  }

  // Vercel: read the runtime's request context directly off globalThis.
  const vctx = vercelRequestContext();
  if (vctx?.waitUntil) {
    vctx.waitUntil(safe);
    return;
  }

  // Long-running Node: nothing else to do. The promise is running; the
  // process won't exit underneath it.
}
