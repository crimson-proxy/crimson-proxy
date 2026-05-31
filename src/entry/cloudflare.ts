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
 * Per-request DB lifecycle: we used to call resetDb() via ctx.waitUntil
 * after every response so the next request opened a fresh socket — the
 * default Workers rule is "TCP sockets are scoped to the request that
 * opened them" and reusing a socket from request A inside request B
 * throws "Cannot perform I/O on behalf of a different request."
 *
 * That reset was a NET NEGATIVE once parallel-request traffic hit:
 * request A's resetDb tears down the socket the postgres.js singleton
 * holds while request B is mid-query on it, and request B fails with
 * "Connection terminated unexpectedly." On the dashboard's first page
 * load that fires 5-6 parallel /api/* requests, this manifested as
 * intermittent 500s on /api/keys, /health, /api/status — refresh fixes
 * it.
 *
 * Fix: the no_handle_cross_request_promise_resolution compat flag in
 * wrangler.toml lifts that scoping restriction, so the singleton socket
 * can live across requests. No more resetDb needed — the socket stays
 * warm for the life of the isolate.
 */

import app from "../server/app.js";
import { resetDb, setConnectionString } from "../server/lib/db.js";

interface Env {
  HYPERDRIVE?: { connectionString: string };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env.HYPERDRIVE?.connectionString) {
      setConnectionString(env.HYPERDRIVE.connectionString);
    }
    const response = await app.fetch(request, env, ctx);
    ctx.waitUntil(resetDb());
    return response;
  },
};
