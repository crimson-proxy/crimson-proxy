/**
 * Shared Postgres client singleton.
 *
 * Replaces lib/supabase.ts. Every module that needs the database imports
 * getDb() from here. One connection pool per process.
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
 * ─── Cloudflare Workers note ──────────────────────────────────────────
 * `postgres` (npm: postgres@^3) works on Workers when wrangler.toml has
 * `compatibility_flags = ["nodejs_compat"]` set, which polyfills Node's
 * `net` module so TCP connections to Aiven succeed.
 *
 * For higher request volume, add a Hyperdrive binding in wrangler.toml
 * pointing at the Aiven URL and set DATABASE_URL via the binding's
 * connection string — Hyperdrive pools connections at the edge so 100k
 * Worker requests don't exhaust Aiven's 20-connection limit.
 *
 * One gotcha when mirroring on Cloudflare + Vercel: Hyperdrive keeps its
 * pool warm 24/7, so its `origin_connection_limit` is a permanent
 * reservation against Aiven's cap. On Aiven free tier (20 slots) the
 * default Hyperdrive limit of 20 leaves Vercel with zero — set it lower
 * (e.g. 13) so Vercel still has slots. See README "Aiven connection cap
 * when mirroring" and wrangler.toml.
 */

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
let instance: Sql | null = null;

/**
 * Runtime override for the connection string. Used by the Cloudflare
 * entry adapter to inject `env.HYPERDRIVE.connectionString` per request
 * (Hyperdrive bindings live on c.env, not process.env, so they have to
 * be plumbed in this way).
 *
 * Cloudflare scopes I/O objects (TCP sockets, streams) to the request
 * that created them — a socket opened in request A throws "Cannot
 * perform I/O on behalf of a different request" if reused in request B.
 * The Cloudflare entry calls resetDb() via ctx.waitUntil after every
 * fetch so the next request opens a fresh socket in its own I/O
 * context. Node/Vercel keep the singleton (long-lived process, no
 * isolation).
 */
let injectedConnectionString: string | null = null;
export function setConnectionString(url: string): void {
  injectedConnectionString = url;
}

/**
 * Close + drop the current client. Cloudflare entry calls this after
 * every request via ctx.waitUntil so the cached socket from one request
 * isn't reused by the next one.
 */
export async function resetDb(): Promise<void> {
  const current = instance;
  instance = null;
  if (current) {
    try {
      await current.end({ timeout: 1 });
    } catch {
      // ignore — connection may already be torn down
    }
  }
}

function readConnectionString(): string | null {
  return (
    injectedConnectionString ||
    process.env.DATABASE_URL ||
    process.env.AIVEN_DATABASE_URL ||
    null
  );
}

/** True if a Postgres connection string is configured. */
export function hasDb(): boolean {
  return readConnectionString() !== null;
}

/**
 * Get the shared Postgres client. Lazily created on first call.
 * Throws if no DATABASE_URL / AIVEN_DATABASE_URL is set.
 */
export function getDb(): Sql {
  if (instance) return instance;

  const url = readConnectionString();
  if (!url) {
    throw new Error(
      "Postgres is not configured. Set DATABASE_URL (or AIVEN_DATABASE_URL).",
    );
  }

  // When connecting via Cloudflare Hyperdrive the URL points at
  // <id>.hyperdrive.local:5432 — TLS is terminated by Hyperdrive, so
  // the Worker→Hyperdrive hop is plain TCP. Detect that and disable SSL.
  const isHyperdrive = url.includes("hyperdrive.local") || url.includes("hyperdrive.internal");
  instance = postgres(url, {
    ssl: isHyperdrive ? false : "require",
    // Pool sizing tuned for serverless: small but not zero. On Vercel /
    // Workers each warm instance keeps its own pool; on a long-running
    // Node host this stays comfortably under any reasonable host's cap.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Disable prepared-statement caching across connection resets — the
    // pooler on Aiven recycles connections under us, and a stale plan
    // surfaces as a confusing "prepared statement does not exist" error.
    prepare: false,
  });

  return instance;
}
