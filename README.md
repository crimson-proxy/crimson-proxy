# Crimson's Proxy

A self-hosted, OpenAI-compatible API gateway with a React dashboard.

Stack: **Hono** backend, **React + Vite** frontend, **raw Postgres** (`postgres` npm) on **Aiven**. Three entry adapters — `src/entry/cloudflare.ts` (Cloudflare Workers, primary), `api/index.ts` (Vercel mirror — dashboard/auth only; `/v1` is Cloudflare-only), `src/server/server.ts` (Node, for VPS / local dev) — all share the same `src/server/app.ts` Hono app.

Clients that speak OpenAI's `/v1/chat/completions` format (Janitor AI, OpenCode, etc.) point at this server, and it routes each request to the configured upstream provider.

> **New here, or just inherited this project?** Start with **[SETUP.md](SETUP.md)** — a plain-language, step-by-step setup guide. This README is the deeper technical reference.

## Features

- **Multi-provider routing** — OpenRouter and any OpenAI-compatible upstream you add from the admin panel, plus mock (for testing)
- **OpenAI-compatible API** — Drop-in replacement for any client that supports custom endpoints
- **Discord bot integration** — Slash commands for API key management (`/get-api-key`, `/models`, etc.). Uses Discord's deferred-response pattern (`type: 5` ack + followup webhook PATCH) so a cold-start handshake to Postgres can't blow the 3 s reply deadline.
- **Discord OAuth dashboard** — Login at `/login`, admin panel at `/admin`
- **Per-user rate limiting** — 5 requests/minute via Postgres, fail-open when unavailable
- **Secure API key auth** — SHA-256 hashed keys, never stores plaintext
- **Portable hosting** — same Hono codebase deploys to Vercel, Cloudflare Workers, or a Node host. Pick one or run mirrors on two

## Architecture

```
Client (Janitor AI / OpenCode / curl)
    │  POST /v1/chat/completions  (OpenAI format)
    ▼
Hono backend (Node or Vercel)
    │  registry.resolveModel(model) by prefix
    ▼
Provider (mock / openrouter / any DB-driven OpenAI-compatible)
    │  authenticates and forwards
    ▼
Upstream API
```

Two halves of the codebase:

- **Backend** (`src/server/`) — Hono server. Exposes `/v1/models`, `/v1/chat/completions`, `/health`, `/api/logs`, `/api/admin/*`, `/api/auth/*`. Routes through a pluggable provider registry. Runs on Node or Vercel without code changes.
- **Frontend** (`src/app/`) — React dashboard. Login via Discord OAuth at `/login`, admin panel at `/admin`.

## Quick start (local)

```bash
npm install
cp .env.example .env
# Edit .env — the mock provider works out of the box for smoke testing;
# add real provider credentials from the admin panel once Discord OAuth
# is configured.
```

### Two local test setups

You have a choice of which runtime to test against. Both run the same Hono app from `src/server/app.ts`; only the entry adapter and config source differ.

#### A. Node + Vite (simulates the Vercel prod path)

```bash
npm run dev:server   # Backend on :3000  (reads .env)
npm run dev          # Frontend on :5173 (Vite, proxies API calls → :3000)
```

Open `http://localhost:5173`. The Vite dev server proxies every `/api/*`, `/v1/*`, `/discord/*`, and `/health` request to the Hono backend on `:3000`. Backend reads `process.env` from `.env`. This is the standard dev loop and the same code path Vercel runs in production.

#### B. Wrangler (simulates the Cloudflare prod path)

```bash
npm run dev:cf       # Backend on :8787 (reads .dev.vars)
npm run dev          # Frontend on :5173 (Vite, but proxies → :3000 by default)
```

Open `http://localhost:8787` directly to hit the Worker, or change `vite.config.ts` proxy target to `:8787` if you want the React frontend to call the Worker.

`wrangler dev` runs the same Hono app inside a local `workerd` (the real Cloudflare runtime), reading secrets from `.dev.vars`. Use this when you want to catch Cloudflare-specific issues (TCP handling, `nodejs_compat` polyfills, etc.) before deploying.

### Smoke tests

```bash
curl -s http://localhost:3000/health           # Node entry
curl -s http://localhost:8787/health           # Workers entry (when dev:cf is running)
curl -s http://localhost:3000/api/models       # Should return the real DB-driven catalog
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer crp_yourkey' \
  -H 'Content-Type: application/json' \
  -d '{"model":"or/<your-model>","messages":[{"role":"user","content":"hi"}]}'
```

## Database setup

The project uses a raw Postgres database for persistence (API keys, request logs, providers, rate limiting). Any Postgres host works: Aiven, Supabase, Neon, RDS, or a self-hosted server. Set one env var:

```env
DATABASE_URL=postgres://<user>:<pass>@<host>:<port>/<db>?sslmode=require
```

(`AIVEN_DATABASE_URL` is also accepted as an alias — `migrate.ts` prefers it during cutover windows.)

Then run the migration script to create all tables:

```bash
npm run migrate
```

Idempotent — safe to run multiple times.

## Admin panel

The `/admin` route provides a web UI for managing providers, tiers/limits, request logs, and user moderation. Access is granted to any Discord user with one of the configured admin roles. No password needed — log in with Discord and if you have the right role, you're in.

Set in `.env`:

```env
ADMIN_SIGNING_SECRET=<random string for JWT signing>
DISCORD_ADMIN_ROLE_IDS=<comma-separated Discord role IDs>
```

## Dashboard authentication (Discord OAuth)

The landing page at `/` is public and shows available models. The dashboard at `/dashboard` requires Discord OAuth login. Users must be members of your Discord server and have the required role.

1. Open your app at <https://discord.com/developers/applications>.
2. Under **OAuth2**, copy the **Client Secret**.
3. Under **OAuth2 > Redirects**, add:
   - `http://localhost:5173/login` (local dev)
   - `https://your-domain.vercel.app/login` (production)
4. Set in `.env`:

   ```env
   DISCORD_CLIENT_SECRET=<your client secret>
   ```

The other Discord env vars (`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_SERVER_ID`, `DISCORD_REQUIRED_ROLE_ID`, etc.) come from the Developer Portal too. Register slash commands once with `npm run register-discord`.

## Providers

Providers are **DB-driven**. Every OpenAI-compatible provider (OpenRouter and anything you add later) is a row in the `providers` + `provider_models` tables, managed entirely from the admin dashboard — no code change, no redeploy. Only Mock remains in code.

Each provider has a 2–4 char **prefix** that users include in the model name (`or/llama-3-70b`). Prefixes namespace providers so two can never collide. Every request **must** carry a prefix — a bare name like `gpt-4` returns `400`.

### Adding an OpenAI-compatible provider (no code)

1. Log into `/admin` → **Limits & Config → Providers → Add provider**.
2. Enter a display name, a 2–4 char prefix, the base URL (ending in `/v1`), and the API key. Hit **Validate** to probe it, then **Add**.
3. New providers are added **hidden** (enabled but not visible), so you can test them in production first — call their models directly to confirm they work, then tick **Visible** to reveal them. See *Enabled vs Visible* below.
4. The model catalog is pulled from the upstream's `GET /v1/models` automatically. Expand the provider to **mask** (rename), **disable**, add, or remove individual models. Use **Refresh models** to re-pull later.
5. Per-provider and per-tier RPM/RPD/TPD limits are set on the same page.

### Enabled vs Visible

Two independent provider flags on the Providers panel:

- **Enabled** — the master switch. Disabled = the provider is fully off: not listed, not counted on the status board, and **not callable** (requests 503).
- **Visible** — only meaningful while Enabled. Visible = appears in `/v1/models`, `/api/models`, and the status board (normal). **Not** visible = the provider is **still callable** if a client knows the model id, but it's hidden from every listing and from the status board.

`enabled + not visible` is a **staging mode**: turn a provider on, call its models directly to test them in production, then flip Visible on when you're happy. New providers start hidden; existing providers were left visible by the migration so nothing changed for them. Hidden is *undiscoverable*, not access-controlled — anyone who knows the model id can still call it.

### Mock (code, test-only)

Model prefix: `mock/`. No setup, always works. `mock/echo` echoes the last user message; `mock/lorem` returns lorem ipsum. Hidden from the public model list and the admin Providers panel.

## Deploying

The Hono backend has three entry adapters, one per target. Pick the host you want — the same `src/server/` code runs everywhere.

| Target | Entry file | Deploy command | Best free tier for |
|---|---|---|---|
| Cloudflare Workers | `src/entry/cloudflare.ts` | `npm run deploy:cf` | bandwidth-heavy streaming, primary |
| Vercel | `api/index.ts` | `vercel --prod` | dashboard/auth mirror (not `/v1`) |
| Node (VPS / local) | `src/server/server.ts` | `npm run start:server` | self-hosted or local dev |

Required env vars (set in each host's secret store, **not** committed):

- `DATABASE_URL` — Postgres connection string for the runtime
- `ADMIN_SIGNING_SECRET` — HMAC for admin JWTs
- `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_SERVER_ID`, `DISCORD_REQUIRED_ROLE_ID`, `DISCORD_ADMIN_ROLE_IDS`, `DISCORD_STAFF_CHANNEL_ID`, `DISCORD_CLIENT_SECRET`

OpenAI-compatible providers (OpenRouter, custom) are NOT configured via env — add them from `/admin → Limits & Config → Providers`.

### Cloudflare Workers

```bash
npm install -g wrangler    # or use npx
wrangler login             # one-time
# Set each secret listed in wrangler.toml (10 total):
wrangler secret put DATABASE_URL
wrangler secret put ADMIN_SIGNING_SECRET
wrangler secret put DISCORD_APP_ID
# ...and so on for the rest of the Discord vars
npm run deploy:cf
```

The React dashboard goes to Cloudflare Pages as a separate project (build command `npm run build`, output `dist/`). The Worker handles the API; Pages handles the static frontend.

Local dev: copy `.dev.vars.example` to `.dev.vars`, fill in values, then `npm run dev:cf`.

### Vercel

```bash
npm install -g vercel    # one-time
vercel login             # one-time
vercel --prod            # each deploy
```

Set env vars in the Vercel dashboard (Settings → Environment Variables). The same `dist/` build serves both the API (via `api/index.ts`) and the static dashboard.

### Long-running Node (VPS)

```bash
npm install
npm run build         # builds the dashboard
npm run start:server  # runs the backend
```

Serves both API and built dashboard from the same process.

### Multi-host operations

Running mirrors on Cloudflare + Vercel is supported. Both deployments must:

- Be on the same git commit.
- Have identical env vars set in each host's secret store.
- Have their domain added to the Discord OAuth redirect list.

Pick a primary (Cloudflare recommended for bandwidth), announce that URL, and use the other only if the primary is down. Pushing to GitHub does **not** trigger a deploy — each host is deployed manually with its own command.

#### Aiven connection cap when mirroring

Aiven's free tier allows ~20 simultaneous connections to the database. **Cloudflare Hyperdrive holds its pool warm 24/7** even when nobody is hitting the Worker, so its `origin_connection_limit` is a permanent reservation against that cap. If Hyperdrive is set to 20 (the default), Vercel gets zero slots and the registry on Vercel falls back to its mock-only snapshot — the homepage shows "no models available."

Cap Hyperdrive at ~45% of Aiven's limit so the Vercel mirror always has headroom:

```bash
npx wrangler hyperdrive list                                                    # find the id
npx wrangler hyperdrive update <id> --origin-connection-limit 9                 # 9 of 20
```

Symptom that this needs doing: `/health` on Vercel returns only `{id:"mock"}` under `providers` while Cloudflare returns the full list.

While on a higher Aiven plan (e.g. the 200-connection trial) this is moot — Hyperdrive at 9 still works the same, with much more headroom for everything.

#### Cloudflare quirks (don't touch unless you read this)

Cloudflare Workers + raw Postgres has three load-bearing knobs. **All three are mandatory** — disabling any of them breaks the live site. Confirmed by running the experiments.

1. **`compatibility_flags = ["nodejs_compat", "no_handle_cross_request_promise_resolution"]`** in `wrangler.toml`. The second flag lets the postgres.js singleton TCP socket survive parallel requests on the same Worker isolate. Without it, the dashboard's burst of parallel `/api/*` calls cancel each other's queries and return intermittent 500s.
2. **The Hyperdrive binding in `wrangler.toml`** is mandatory. Without it, every database query counts as a "subrequest" — Cloudflare's 50-per-invocation cap is blown by a single dashboard page load (~30 queries) and the Worker hangs for ~60s before Cloudflare cancels it.
3. **`ctx.waitUntil(resetDb())` in `src/entry/cloudflare.ts`** is mandatory. Without it, the singleton postgres connection goes stale between requests and `/api/models`, `/api/auth/discord/callback`, etc. hang.

Vercel has none of these issues (no subrequest cap, no cross-request socket scoping, long-lived Node process), which is why it's been steadier for the dashboard. Note the split: **only Cloudflare serves the OpenAI `/v1` API** — `api/index.ts` returns `410 Gone` for `/v1/*` and points clients at the Cloudflare URL. Vercel mirrors the dashboard / auth / admin surface, so it's a fallback for those, not for chat traffic.

The frontend also installs a global fetch-retry wrapper (`src/app/lib/fetch-retry.ts`) that silently retries any 5xx / network error up to 3× — masks the rare Cloudflare flake without user-visible errors.

### Env var sync rule

**Every value in `.env` must also live in `.dev.vars`, Vercel, and Cloudflare — four stores, byte-identical values.** When you add or change a secret locally, push the same value to all four before deploying. Drift between any of them is the most common cause of "works locally, broken in prod" outages.

| Where | How to set | Used by |
|---|---|---|
| `.env` | edit the file | `npm run dev:server`, `npm run migrate`, any local script |
| `.dev.vars` | edit the file (gitignored, mirrors `.env` plus one wrangler-local var — see file header) | `npm run dev:cf` |
| Vercel | dashboard Settings → Environment Variables, or `vercel env add NAME production --force` (`--force` overwrites on re-sync) | the `vercel --prod` deploy |
| Cloudflare | `wrangler secret put NAME` for secrets; `[vars]` in `wrangler.toml` + commit for non-secrets | the `npm run deploy:cf` deploy |

A simple workflow when rotating a secret (e.g., the admin signing secret):

```bash
# 1. Generate the new value
openssl rand -base64 32

# 2. Update local .env and .dev.vars (paste new value)

# 3. Push to Vercel
echo "NEW_VALUE_HERE" | vercel env add ADMIN_SIGNING_SECRET production --force

# 4. Push to Cloudflare
echo "NEW_VALUE_HERE" | wrangler secret put ADMIN_SIGNING_SECRET

# 5. Redeploy both hosts
vercel --prod
npm run deploy:cf
```

`.env.example` is the canonical reference for which variables exist and what they're for. Keep `.env.example` and `.env` structurally identical (same comments, same ordering) — only the values differ.

## API reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | None | Server status, provider health |
| `/v1/models` | GET | API key | All models (OpenAI-compatible, prefixes stripped) |
| `/v1/chat/completions` | POST | API key | OpenAI-compatible chat (streaming or not) |
| `/api/models` | GET | None | All models grouped by provider (for dashboard/landing) |
| `/api/keys` | GET | Session JWT | Logged-in user's API key metadata |
| `/api/logs` | GET | Admin JWT | Last 100 request logs |
| `/api/logs` | DELETE | Admin JWT | Clear logs |
| `/api/admin/login` | POST | Session JWT | Verify admin role and get admin JWT |
| `/api/auth/config` | GET | None | Discord client ID for OAuth |
| `/api/auth/discord/callback` | POST | None | Exchange OAuth code for session |
| `/api/auth/me` | GET | Session JWT | Current user info |
| `/discord/interactions` | POST | Ed25519 | Discord bot webhook |

## Scripts

| Script | Description |
|---|---|
| `npm run migrate` | Create/update Postgres tables |
| `npm run register-discord` | Register Discord slash commands |
| `npm run backup-db` | Dump every table to a timestamped backup |

## More docs

- **[SETUP.md](SETUP.md)** — Plain-language, step-by-step setup (environment variables, getting the site running).

## License

Private. Do not redistribute.
