/**
 * Shared Postgres client.
 *
 * Replaces lib/supabase.ts. Every module that needs the database imports
 * getDb() from here.
 *
 * Connection string priority:
 *   1. DATABASE_URL                 — canonical (post-migration)
 *   2. AIVEN_DATABASE_URL           — explicit Aiven override
 *
 * SSL is required on every supported host (Aiven, Supabase direct, Neon,
 * Render). The `postgres` package accepts `ssl: "require"` which trusts
 * any cert — fine for managed hosts that present their own valid certs.
 * If you ever self-host Postgres with a self-signed cert, pass the CA
 * via `ssl: { ca: fs.readFileSync(...) }` here instead.
 *
 * ─── Two client lifetimes, picked by runtime ─────────────────────────
 * Node / Vercel: a process-wide SINGLETON. The process outlives any one
 * request, so a single shared pool is correct and a socket opened in one
 * invocation is never touched by a concurrent one.
 *
 * Cloudflare Workers: ONE CLIENT PER REQUEST, via AsyncLocalStorage.
 * Workers scope every I/O object (TCP sockets, streams) to the request
 * handler that created it — writing to a socket from a different request
 * throws "Cannot perform I/O on behalf of a different request (I/O type:
 * Writable)". And Workers run multiple requests concurrently in one
 * isolate, so a single shared postgres socket gets written by a request
 * that didn't open it the instant two requests overlap (e.g. the admin
 * dashboard firing /api/admin/chart and /api/admin/logs in parallel).
 * Giving each request its own client removes the sharing entirely. The
 * Cloudflare entry wraps every request in runWithRequestDb(); getDb()
 * then creates/returns a client scoped to that one request.
 *
 * `postgres` (npm: postgres@^3) works on Workers when wrangler.toml has
 * `compatibility_flags = ["nodejs_compat"]` set, which polyfills Node's
 * `net` module (TCP) and `node:async_hooks` (AsyncLocalStorage).
 *
 * For higher request volume, add a Hyperdrive binding in wrangler.toml
 * pointing at the Aiven URL and set DATABASE_URL via the binding's
 * connection string — Hyperdrive pools connections at the edge so 100k
 * Worker requests don't exhaust Aiven's 20-connection limit. Per-request
 * clients connect to Hyperdrive (local), which multiplexes to origin, so
 * the per-request fan-out doesn't map 1:1 onto Aiven slots.
 *
 * One gotcha when mirroring on Cloudflare + Vercel: Hyperdrive keeps its
 * pool warm 24/7, so its `origin_connection_limit` is a permanent
 * reservation against Aiven's cap. On Aiven free tier (20 slots) the
 * default Hyperdrive limit of 20 leaves Vercel with zero — set it lower
 * (e.g. 9) so Vercel still has slots. See README "Aiven connection cap
 * when mirroring" and wrangler.toml.
 */

import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

type Sql = ReturnType<typeof postgres>;

/**
 * Process-wide singleton. Used on long-running Node and on Vercel (Node
 * serverless), where the process outlives the request and there is no
 * per-request I/O isolation, so one shared pool is correct. Stays null on
 * Cloudflare, where every getDb() runs inside a request scope (below).
 */
let instance: Sql | null = null;

/**
 * Per-request client store (Cloudflare). runWithRequestDb() enters this
 * scope around the whole request; getDb() lazily creates a client in it.
 * Background tasks spawned with runInBackground() (the request_logs
 * insert, the Discord followup, the warmer) keep working because the
 * promise is created synchronously inside the scope, so AsyncLocalStorage
 * propagates the same store across the post-response await chain.
 */
type RequestDb = { sql: Sql | null };
const requestScope = new AsyncLocalStorage<RequestDb>();

/**
 * Runtime override for the connection string. Used by the Cloudflare
 * entry adapter to inject `env.HYPERDRIVE.connectionString` per request
 * (Hyperdrive bindings live on c.env, not process.env, so they have to
 * be plumbed in this way). It's the same value every request, so setting
 * a module global is fine.
 */
let injectedConnectionString: string | null = null;
export function setConnectionString(url: string): void {
  injectedConnectionString = url;
}

function readConnectionString(): string | null {
  return (
    injectedConnectionString ||
    process.env.DATABASE_URL ||
    process.env.AIVEN_DATABASE_URL ||
    null
  );
}

function requireConnectionString(): string {
  const url = readConnectionString();
  if (!url) {
    throw new Error(
      "Postgres is not configured. Set DATABASE_URL (or AIVEN_DATABASE_URL).",
    );
  }
  return url;
}

/** True if a Postgres connection string is configured. */
export function hasDb(): boolean {
  return readConnectionString() !== null;
}

function createClient(url: string): Sql {
  // When connecting via Cloudflare Hyperdrive the URL points at
  // <id>.hyperdrive.local:5432 — TLS is terminated by Hyperdrive, so
  // the Worker→Hyperdrive hop is plain TCP. Detect that and disable SSL.
  const isHyperdrive =
    url.includes("hyperdrive.local") || url.includes("hyperdrive.internal");
  return postgres(url, {
    ssl: isHyperdrive ? false : "require",
    // Pool sizing tuned for serverless: small but not zero. On Node /
    // Vercel this is the whole process's pool; on Cloudflare it's
    // per-request, where it caps how many queries one request runs in
    // parallel (the heaviest, /api/admin/logs, runs ~3). On a
    // long-running Node host this stays comfortably under any reasonable
    // host's cap.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Disable prepared-statement caching across connection resets — the
    // pooler on Aiven recycles connections under us, and a stale plan
    // surfaces as a confusing "prepared statement does not exist" error.
    prepare: false,
  });
}

/**
 * Run `fn` (the entire request) inside a fresh per-request DB scope. Only
 * the Cloudflare entry calls this; Node/Vercel run outside any scope and
 * fall through to the singleton in getDb().
 *
 * We deliberately do NOT end() the request client when fn settles:
 * background tasks (the request_logs insert, the Discord followup PATCH,
 * the warmer) issue queries AFTER the response via waitUntil, and end()
 * would reject those. The client instead self-reaps via idle_timeout once
 * its last query settles — and because it was never shared with another
 * request, a lingering socket is only a resource cost, never a
 * cross-request I/O error.
 */
export function runWithRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  return requestScope.run({ sql: null }, fn);
}

/**
 * Get the Postgres client for the current context. Inside a request scope
 * (Cloudflare) this is a per-request client; otherwise (Node/Vercel) it's
 * the process singleton. Lazily created on first use. Throws if no
 * DATABASE_URL / AIVEN_DATABASE_URL is set.
 */
export function getDb(): Sql {
  const scope = requestScope.getStore();
  if (scope) {
    if (!scope.sql) scope.sql = createClient(requireConnectionString());
    return scope.sql;
  }

  if (instance) return instance;
  instance = createClient(requireConnectionString());
  return instance;
}
