/**
 * Cloudflare Workers entry point.
 *
 * Workers expect `export default { fetch(request, env, ctx) }`. Hono's
 * `app.fetch` matches that signature exactly, so we forward it.
 *
 * Env wiring: with `compatibility_flags = ["nodejs_compat"]` set in
 * wrangler.toml, the bindings declared there (vars + secrets) are
 * automatically exposed on `process.env`. That means `src/server/lib/config.ts`
 * works unchanged — every `readEnv("X")` call resolves to the same
 * `process.env.X` it does on Node/Vercel.
 *
 * Hyperdrive: the `HYPERDRIVE` binding is an object (not a string), so
 * it doesn't show up on `process.env`. On every request we hand its
 * `connectionString` to lib/db.ts via setConnectionString().
 *
 * Per-request DB lifecycle: we wrap the whole request in
 * runWithRequestDb() so getDb() hands out a client scoped to THIS request
 * (see lib/db.ts). Workers scope TCP sockets to the request that opened
 * them — a socket reused by another request throws "Cannot perform I/O on
 * behalf of a different request (I/O type: Writable)", and because Workers
 * run requests concurrently in one isolate, a single shared postgres
 * socket hits exactly that the moment two requests overlap (e.g. the admin
 * dashboard firing /api/admin/chart and /api/admin/logs in parallel). A
 * per-request client removes the sharing entirely. We do NOT tear it down
 * here: background tasks (the request_logs insert, the Discord followup)
 * run after the response via waitUntil and still need it; it self-reaps
 * via idle_timeout, and since it was never shared, lingering is harmless.
 *
 * (This replaces the old singleton + resetDb() dance. That approach was
 * broken both ways under parallel traffic: keep resetDb and request A's
 * teardown kills the socket request B is mid-query on; drop it and request
 * B writes to request A's socket. Per-request clients sidestep both.)
 *
 * The no_handle_cross_request_promise_resolution compat flag in
 * wrangler.toml is still what makes the deferred work safe: it lets the
 * waitUntil promises (the request_logs insert in routes/chat.ts and the
 * Discord followup PATCH in routes/discord.ts) resolve after the response
 * instead of being cancelled with "promise resolved in a different request
 * context."
 */

import app from "../server/app.js";
import { runWithRequestDb, setConnectionString } from "../server/lib/db.js";

interface Env {
  HYPERDRIVE?: { connectionString: string };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env.HYPERDRIVE?.connectionString) {
      setConnectionString(env.HYPERDRIVE.connectionString);
    }
    return runWithRequestDb(() => app.fetch(request, env, ctx));
  },
};
