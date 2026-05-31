/**
 * Crimson Proxy — Database Schema (initial-build + idempotent rerun)
 *
 * Usage: npm run migrate
 *
 * This is the only schema script. It builds a fresh DB from scratch on
 * first run and is a no-op on a populated DB — every CREATE uses
 * IF NOT EXISTS, every backfill UPDATE is guarded so it doesn't clobber
 * admin-tuned values.
 *
 * Requires SUPABASE_URL and SUPABASE_DB_PASSWORD in .env.
 *
 * ─── What's in the schema (in source order) ─────────────────────────
 *   users                  Discord profile + cached roles
 *   api_keys               proxy API keys (sha256-hashed)
 *   request_logs           one row per /v1 request, the audit trail
 *   banned_users           ban / timeout history (multiple cycles per user)
 *   action_logs            generic admin audit log
 *   rate_limit_hits        retired (replaced by lib/usage-limit.ts)
 *   vixai_limit_hits       retired (replaced by lib/usage-limit.ts)
 *   app_config             DB-overridable bootstrap config
 *   providers              every provider (builtin + DB-driven openai)
 *   tiers                  Discord-role-based limit overrides
 *   tier_provider_limits   per-tier × per-provider overrides
 *   provider_models        per-provider model catalog (mask + enable)
 *   warming_logs           synthetic upstream calls fired by lib/warmer.ts
 *                          to keep cold models' /status strips populated
 *
 * ─── Adding a new column ────────────────────────────────────────────
 * Add it to the relevant CREATE TABLE block at the top. If existing
 * rows need a non-default value, add a guarded UPDATE in the
 * "Data backfills" section near the bottom (the same way the
 * provider kind/prefix/owner_id backfills work). The ALTER block that
 * used to live here was retired once production caught up.
 */

import "dotenv/config";
import postgres from "postgres";

/**
 * Connection priority: AIVEN_DATABASE_URL (the target post-migration)
 * wins over the Supabase pooler. During the cutover window both are set;
 * once Aiven is the source of truth we drop SUPABASE_DB_PASSWORD entirely.
 */
const AIVEN_DATABASE_URL = process.env.AIVEN_DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;

let sql: ReturnType<typeof postgres>;
let target: string;

if (AIVEN_DATABASE_URL) {
  sql = postgres(AIVEN_DATABASE_URL, { ssl: "require" });
  target = `Aiven (${new URL(AIVEN_DATABASE_URL).hostname})`;
} else if (SUPABASE_URL && SUPABASE_DB_PASSWORD) {
  // Supabase's direct connection is IPv6-only. Use the session pooler
  // (IPv4) instead. Session mode supports DDL (CREATE TABLE etc.).
  // Pooler username format: postgres.<project-ref>
  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
  sql = postgres({
    host: "aws-1-us-east-1.pooler.supabase.com",
    port: 5432,
    database: "postgres",
    username: `postgres.${projectRef}`,
    password: SUPABASE_DB_PASSWORD,
    ssl: "require",
  });
  target = `Supabase (${projectRef})`;
} else {
  console.error("Missing AIVEN_DATABASE_URL (or SUPABASE_URL + SUPABASE_DB_PASSWORD) in .env");
  console.error("AIVEN_DATABASE_URL looks like: postgres://avnadmin:...@host:port/defaultdb?sslmode=require");
  process.exit(1);
}

console.log(`Migrating against: ${target}`);

const SCHEMA = `
-- ─── Users ─────────────────────────────────────────────────────────────
-- Discord profile info. Upserted on every OAuth login and bot interaction
-- so display names and avatars stay fresh. roles/roles_updated_at are a
-- per-user role cache so the /v1 hot path can resolve a user's tier
-- without a live Discord guild-member fetch on every request — see
-- lib/user-roles.ts for the freshness rules.
create table if not exists users (
  discord_id text primary key,
  username text not null,
  avatar text,
  roles text[] not null default '{}',
  roles_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── API Keys ──────────────────────────────────────────────────────────
-- Keys are stored as SHA-256 hashes. The plaintext only exists at
-- creation time. key_preview stores first 8 + last 4 chars for display.
create table if not exists api_keys (
  id bigserial primary key,
  key_hash text not null unique,
  key_preview text,
  discord_user_id text not null,
  discord_username text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  notes text
);

create index if not exists api_keys_discord_user_id_idx
  on api_keys (discord_user_id);
create index if not exists api_keys_active_lookup_idx
  on api_keys (key_hash) where revoked_at is null;

-- ─── Request Logs ──────────────────────────────────────────────────────
-- One row per proxied API request.
--
-- Token columns (prompt_tokens, completion_tokens, total_tokens) and the
-- per-provider account columns (account_id, account_label) were added
-- after the table already had ~700 rows; that's why they're nullable.
-- Rows written before the column was added stay null until backfilled.
create table if not exists request_logs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  method text not null,
  endpoint text not null,
  status int not null,
  duration_ms int not null,
  model text,
  message_count int,
  via text,
  error text,
  error_type text,
  discord_user_id text,
  discord_username text,
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,
  account_id bigint,
  account_label text
);

create index if not exists request_logs_created_at_idx
  on request_logs (created_at desc);
-- request_logs_account_id_idx is created at the bottom, after the ALTERs
-- that add account_id on tables predating the column.

-- ─── Banned Users ──────────────────────────────────────────────────────
-- Supports multiple ban/unban cycles per user for historical tracking.
-- expires_at NULL = permanent ban; non-null = timeout that auto-expires.
-- banned_by/unbanned_by record which admin took the action so action_logs
-- joins resolve to a name without a separate query.
create table if not exists banned_users (
  id bigserial primary key,
  discord_id text not null,
  reason text,
  banned_at timestamptz not null default now(),
  banned_by text,
  unbanned_at timestamptz,
  unbanned_by text,
  expires_at timestamptz
);

-- ─── Action Logs ───────────────────────────────────────────────────────
-- Generic audit trail for all admin and user actions (ban, unban,
-- key creation, revocation, etc.).
create table if not exists action_logs (
  id bigserial primary key,
  actor_id text not null,
  action text not null,
  target_id text,
  reason text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ─── Rate Limit Hits (RETIRED) ─────────────────────────────────────────
-- No longer written or read. The limiter now derives RPM/RPD/TPD from
-- request_logs (lib/usage-limit.ts) instead of a counter table. Kept here
-- (create-if-not-exists) only so existing deployments don't error and no
-- historical rows are dropped; safe to delete manually once you're sure
-- you don't want the old data.
create table if not exists rate_limit_hits (
  id bigserial primary key,
  discord_user_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_user_time_idx
  on rate_limit_hits (discord_user_id, created_at desc);

-- ─── VixAI Limit Hits (RETIRED) ────────────────────────────────────────
-- Also retired by the unified limiter (see above). Was a per-user counter
-- for the vx provider's old hardcoded 200/day + 5/min caps; those numbers
-- are now DB-configured per tier/provider. Kept for the same data-safety
-- reason as rate_limit_hits.
create table if not exists vixai_limit_hits (
  id bigserial primary key,
  discord_user_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists vixai_limit_hits_user_time_idx
  on vixai_limit_hits (discord_user_id, created_at desc);

-- ─── App Config ────────────────────────────────────────────────────────
-- Non-secret operational settings moved out of env (discord_server_id,
-- discord_required_role_id, discord_admin_role_ids, discord_staff_channel_id,
-- global_rpm / global_rpd / global_tpd). DB value overrides env; env stays
-- as the bootstrap fallback. Secrets (bot token, client secret, signing
-- secret, Supabase keys, provider API keys) deliberately stay env-only.
create table if not exists app_config (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- ─── Providers ─────────────────────────────────────────────────────────
-- Every AI provider, code-built-in and DB-driven. Admins manage dynamic
-- (kind='openai') providers from the dashboard; built-ins (mock) are
-- wired in code, only their flags / limits / owner_id are editable.
--   kind          : 'builtin' | 'openai'
--   prefix        : routing prefix users type ('vx', 'or', …);
--                   unique across providers — see partial index below
--   base_url      : upstream OpenAI-compatible endpoint (…/v1)
--   api_key       : upstream bearer key. NEVER returned by any public
--                   route; only the row's owner sees it via /admin GET
--   extra_headers : optional static headers (e.g. OpenRouter ranking)
--   owner_id      : Discord id of the human owner; admin-only display
--                   and the gate for editing this row
--   per_user_*    : cap one user on THIS provider (gate 2)
--   global_*      : cap all users combined on THIS provider (gate 3)
--   models_synced_at : last upstream /v1/models pull (admin Refresh)
-- NULL on any *_rpm/*_rpd/*_tpd = that gate not enforced.
create table if not exists providers (
  id                text primary key,
  display_name      text not null,
  kind              text not null default 'builtin',
  prefix            text,
  base_url          text,
  api_key           text,
  extra_headers     jsonb,
  owner_id          text,
  enabled           boolean not null default true,
  visible           boolean not null default false,
  per_user_rpm      int,
  per_user_rpd      int,
  per_user_tpd      bigint,
  global_rpm        int,
  global_rpd        int,
  global_tpd        bigint,
  models_synced_at  timestamptz,
  updated_at        timestamptz not null default now(),
  updated_by        text
);
-- Routing prefix is the namespace users type before a model id, so it
-- has to be unique. Partial index because legacy rows (pre-overhaul)
-- briefly carried prefix=NULL until the backfill below ran.
create unique index if not exists providers_prefix_idx
  on providers (prefix) where prefix is not null;

-- Provider visibility, separate from enabled. An enabled+invisible
-- provider is fully callable but hidden from /v1/models, /api/models, and
-- the status board — a "staging" mode for testing a provider in production
-- before exposing it to users. (Disabled always wins: a disabled provider
-- is off regardless of visible.)
--
-- Added nullable first so the one-time backfill runs EXACTLY once, guarded
-- by the visible-is-null check: existing providers inherit visible =
-- enabled (live ones stay visible so nothing vanishes on deploy; already-
-- disabled ones become hidden). Then the column is locked to NOT NULL
-- DEFAULT false so providers created afterwards start hidden until an admin
-- reveals them. Re-running migrate is a no-op: the column already exists
-- and no row is null, so the backfill never clobbers an admin's choice.
alter table providers add column if not exists visible boolean;
update providers set visible = enabled where visible is null;
alter table providers alter column visible set default false;
alter table providers alter column visible set not null;

-- ─── Tiers ─────────────────────────────────────────────────────────────
-- Discord-role-based override of the global per-user budget. A user's
-- tier = the highest-priority tier whose discord_role_id is in their
-- roles. A NULL metric falls back to app_config global for that metric.
create table if not exists tiers (
  id              bigserial primary key,
  name            text not null,
  discord_role_id text not null unique,
  priority        int  not null default 0,
  rpm             int,
  rpd             int,
  tpd             bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text
);

-- ─── Tier × Provider overrides ─────────────────────────────────────────
-- Per-tier override for a specific provider (e.g. a VIP tier gets a
-- higher daily cap on one provider). NULL metric = fall through to the
-- provider's per_user_* default for that metric.
create table if not exists tier_provider_limits (
  tier_id      bigint not null references tiers(id) on delete cascade,
  provider_id  text   not null references providers(id) on delete cascade,
  rpm          int,
  rpd          int,
  tpd          bigint,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  primary key (tier_id, provider_id)
);

-- ─── Provider Models ───────────────────────────────────────────────────
-- Per-provider model catalog for the DB-driven (kind='openai') providers.
-- Auto-populated from the upstream's GET /v1/models when a provider is
-- added or refreshed, then editable by admins:
--   - display_name : the bare name users see/paste AFTER the prefix
--                     (e.g. prefix 'vx' + display 'deepseek-v3' →
--                     users type 'vx/deepseek-v3'). Defaults to
--                     upstream_id; admins can "mask" it to anything.
--   - upstream_id  : the real model id forwarded to the provider.
--   - enabled      : admins can hide a model without deleting the row
--                     (kept so a later upstream refresh doesn't lose the
--                     mask/toggle, and so vanished-upstream models can be
--                     auto-disabled instead of 404ing silently).
-- Built-in code providers (tm/mock) do NOT use this table — their model
-- lists stay in code. Routing prefers display_name, falls back to
-- upstream_id (deterministic escape hatch for brand-new upstream models).
create table if not exists provider_models (
  id            bigserial primary key,
  provider_id   text not null references providers(id) on delete cascade,
  upstream_id   text not null,
  display_name  text not null,
  enabled       boolean not null default true,
  owned_by      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);

-- One upstream model maps to exactly one row per provider; masked names
-- must be unique per provider (case-insensitive) so two models can't
-- collide on the name users type. Cross-provider collisions are
-- impossible by construction — the routing prefix namespaces them.
create unique index if not exists provider_models_provider_upstream_idx
  on provider_models (provider_id, upstream_id);
create unique index if not exists provider_models_provider_display_idx
  on provider_models (provider_id, lower(display_name));
create index if not exists provider_models_enabled_idx
  on provider_models (provider_id) where enabled;

-- Indexes for the usage limiter, which derives RPM/RPD/TPD from
-- request_logs (no separate counter table). Gate 1 (user, all providers):
-- (discord_user_id, created_at). Gate 2 (user, one provider):
-- (discord_user_id, via, created_at). Gate 3 (all users, one provider):
-- (via, created_at).
create index if not exists request_logs_user_time_idx
  on request_logs (discord_user_id, created_at desc);
create index if not exists request_logs_user_via_time_idx
  on request_logs (discord_user_id, via, created_at desc);
create index if not exists request_logs_via_time_idx
  on request_logs (via, created_at desc);

-- ─── Warming Logs ──────────────────────────────────────────────────────
-- Synthetic upstream calls fired by lib/warmer.ts to keep cold models'
-- /status strips populated. Same shape as request_logs minus the
-- user/token/account fields (warming has no human attribution and
-- isn't billed against any user's quota). Pruned automatically by
-- prune_warming_logs() below; rows naturally fall off the strip as
-- real traffic displaces them.
create table if not exists warming_logs (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  model         text not null,
  via           text not null,
  status        int  not null,
  duration_ms   int  not null,
  error         text
);
create index if not exists warming_logs_model_time_idx
  on warming_logs (model, created_at desc);

-- Prune warming_logs of rows that have been displaced by real
-- request_logs rows in each model's visible top-20 strip.
--
-- Rule: for every model, sort the union of (request_logs ∪ warming_logs)
-- by created_at desc; any warming row past the 20th position is no
-- longer visible on /status, so it can go. Real rows are never touched.
--
-- Idempotent: running twice in a row deletes the same set the second
-- time (= nothing, because the first call already removed them).
drop function if exists prune_warming_logs();
create or replace function prune_warming_logs()
returns int as $$
declare
  deleted_count int;
begin
  with combined as (
    select id, model, created_at, 'warm' as kind from warming_logs
    union all
    select null::bigint as id, model, created_at, 'real' as kind from request_logs
  ),
  ranked as (
    select id, kind,
           row_number() over (
             partition by model
             order by created_at desc
           ) as rn
    from combined
  ),
  to_delete as (
    select id from ranked where kind = 'warm' and rn > 20 and id is not null
  )
  delete from warming_logs w
  where w.id in (select id from to_delete);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$ language plpgsql;

-- ─── Data backfills ────────────────────────────────────────────────────
-- These transform existing data; they're idempotent (every UPDATE is
-- guarded with WHERE … IS NULL or coalesce) so they're safe to re-run.
-- The old "Schema Migrations" ALTER block was retired once production
-- caught up to the consolidated CREATE TABLE blocks above; if you need
-- to add a new column going forward, add it to the relevant CREATE
-- block AND, if there are existing rows that need a non-default value,
-- add a guarded UPDATE here.

-- Backfill the new columns for the rows the old code hardcoded. Every
-- statement is guarded (coalesce / where … is null) so re-running migrate
-- never clobbers a value an admin tuned in the dashboard.
--   mock → built-in (test-only, stays in code)
--   vx   → DB-driven OpenAI-compatible (VixAI relay)
--   or*  → DB-driven OpenAI-compatible (OpenRouter); id stays 'openrouter'
--          (it's the request_logs.via / limits key) but the user-facing
--          prefix is the short 'or'.
update providers set kind = 'builtin', prefix = coalesce(prefix, 'mock')
  where id = 'mock';
update providers
  set kind = 'openai',
      prefix = coalesce(prefix, 'vx'),
      base_url = coalesce(base_url, 'https://vixbyproxy-vixbyproxy.hf.space/v1')
  where id = 'vx';
update providers
  set kind = 'openai',
      prefix = coalesce(prefix, 'or'),
      base_url = coalesce(base_url, 'https://openrouter.ai/api/v1')
  where id = 'openrouter';
-- Any other pre-existing rows: default the prefix to the id so routing
-- keeps working until an admin sets a shorter one.
update providers set prefix = id where prefix is null;

-- Provider ownership attribution (admin-only). Guarded so an admin
-- reassigning the owner from the dashboard is never clobbered on re-run.
update providers set owner_id = '1492228386532229353'
  where id = 'vx' and owner_id is null;

-- Indexes that depend on columns added by the ALTER block above.
create index if not exists request_logs_account_id_idx
  on request_logs (account_id) where account_id is not null;
`;

/**
 * RPC the admin dashboard calls to build the user leaderboard. Re-created
 * each migration so adding a new aggregate column (tokens) just needs a
 * single source-of-truth edit here.
 */
const USER_STATS_RPC = `
-- Postgres won't allow CREATE OR REPLACE to change the return signature,
-- so we DROP first. Safe because the function is only called from our
-- own admin routes; no cross-extension dependencies.
drop function if exists get_user_stats(text);
create or replace function get_user_stats(search_query text default '')
returns table(
  discord_id text,
  username text,
  avatar text,
  total_requests bigint,
  error_requests bigint,
  total_tokens bigint,
  prompt_tokens bigint,
  completion_tokens bigint,
  last_request timestamptz
) as $$
begin
  return query
  select
    u.discord_id,
    u.username,
    u.avatar,
    count(r.id)::bigint as total_requests,
    count(r.id) filter (where r.status >= 400)::bigint as error_requests,
    coalesce(sum(r.total_tokens), 0)::bigint as total_tokens,
    coalesce(sum(r.prompt_tokens), 0)::bigint as prompt_tokens,
    coalesce(sum(r.completion_tokens), 0)::bigint as completion_tokens,
    max(r.created_at) as last_request
  from users u
  left join request_logs r on u.discord_id = r.discord_user_id
  where search_query = '' or u.username ilike '%' || search_query || '%' or u.discord_id = search_query
  group by u.discord_id, u.username, u.avatar;
end;
$$ language plpgsql;
`;

/**
 * Backfill prompt_tokens / completion_tokens for rows written before the
 * columns existed. We don't have the original prompt or response text
 * (privacy: we never stored it), so this is a rough heuristic from the
 * fields we *do* have.
 *
 *   prompt_tokens     ≈ message_count * 60
 *   completion_tokens ≈ duration_ms / 30
 *
 * Reasoning:
 * - Janitor AI sends 50–500 message conversations averaging ~240 chars
 *   each (the chat history). 240/4 ≈ 60 tokens per message is a fair
 *   middle of the distribution.
 * - Streaming LLMs in this proxy emit roughly 30 tokens/sec end-to-end
 *   (including TTFB), so duration/30 approximates output token count for
 *   successful 200 responses. For errors / very short requests we floor.
 *
 * This is an estimate. New rows track real char counts; backfilled rows
 * will be visibly less accurate but at least non-zero. We only touch
 * rows where prompt_tokens IS NULL so re-running this is a no-op once
 * everything is filled.
 */
const BACKFILL_TOKENS = `
update request_logs
set
  prompt_tokens     = greatest(50, coalesce(message_count, 1) * 60),
  completion_tokens = case
    when status >= 400 then 0
    else greatest(20, coalesce(duration_ms, 0) / 30)
  end,
  total_tokens      = greatest(50, coalesce(message_count, 1) * 60)
                    + case
                        when status >= 400 then 0
                        else greatest(20, coalesce(duration_ms, 0) / 30)
                      end
where prompt_tokens is null;
`;

async function main() {
  console.log(`Running schema setup against: ${target}`);

  try {
    await sql.unsafe(SCHEMA);
    console.log("✅ Schema setup complete.");

    await sql.unsafe(USER_STATS_RPC);
    console.log("✅ RPC get_user_stats updated.");

    const result = await sql.unsafe(BACKFILL_TOKENS);
    const backfilled = (result as unknown as { count: number }).count ?? 0;
    if (backfilled > 0) {
      console.log(`✅ Backfilled token estimates for ${backfilled} legacy rows.`);
    } else {
      console.log("✅ Token backfill: nothing to do (all rows already have tokens).");
    }

    // ─── Seed config + providers ───────────────────────────────────────
    // All inserts are ON CONFLICT DO NOTHING so re-running migrate never
    // clobbers values an admin tuned in the dashboard. Global limit
    // defaults are always seeded (constants); discord_* keys are copied
    // from env only when the env var is set — DB overrides env at runtime,
    // env stays as the bootstrap fallback, so an unset env just means
    // "configure it in the dashboard later".
    const envConfig: Array<[string, string | undefined]> = [
      ["discord_server_id", process.env.DISCORD_SERVER_ID],
      ["discord_required_role_id", process.env.DISCORD_REQUIRED_ROLE_ID],
      ["discord_admin_role_ids", process.env.DISCORD_ADMIN_ROLE_IDS],
      ["discord_staff_channel_id", process.env.DISCORD_STAFF_CHANNEL_ID],
    ];
    const defaultConfig: Array<[string, string]> = [
      ["global_rpm", "5"],
      ["global_rpd", "200"],
      ["global_tpd", "5000000"],
    ];
    let seededConfig = 0;
    for (const [key, value] of [
      ...envConfig.filter((e): e is [string, string] => Boolean(e[1])),
      ...defaultConfig,
    ]) {
      const r = await sql`
        insert into app_config (key, value) values (${key}, ${value})
        on conflict (key) do nothing
      `;
      seededConfig += r.count;
    }
    console.log(
      seededConfig > 0
        ? `✅ Seeded ${seededConfig} app_config key(s) (existing keys untouched).`
        : "✅ app_config: nothing to seed (all keys already set).",
    );

    const providerSeed: Array<[string, string]> = [
      ["vx", "VixAI"],
      ["openrouter", "OpenRouter"],
      ["mock", "Mock"],
    ];
    let seededProviders = 0;
    for (const [id, displayName] of providerSeed) {
      const r = await sql`
        insert into providers (id, display_name) values (${id}, ${displayName})
        on conflict (id) do nothing
      `;
      seededProviders += r.count;
    }
    console.log(
      seededProviders > 0
        ? `✅ Seeded ${seededProviders} provider row(s) (caps NULL — only the global default applies until tuned).`
        : "✅ providers: nothing to seed (all rows already present).",
    );

    // ─── Copy provider credentials env → DB (one-time, zero-downtime) ──
    // The dynamic provider engine reads base_url/api_key from the DB, not
    // env. To avoid an outage window between deploying the new code and an
    // admin pasting keys in the dashboard, copy the keys the old code read
    // from env into the matching rows — but ONLY when api_key is still
    // empty, so re-running migrate (or an admin rotating the key in the
    // dashboard) is never clobbered. After this runs once the env vars are
    // dead and can be removed from the host.
    const credSeed: Array<{
      id: string;
      key?: string;
      headers?: Record<string, string>;
    }> = [
      { id: "vx", key: process.env.VIXAI_API_KEY },
      {
        id: "openrouter",
        key: process.env.OPENROUTER_API_KEY,
        headers:
          process.env.OPENROUTER_REFERER || process.env.OPENROUTER_TITLE
            ? {
                ...(process.env.OPENROUTER_REFERER
                  ? { "HTTP-Referer": process.env.OPENROUTER_REFERER }
                  : {}),
                ...(process.env.OPENROUTER_TITLE
                  ? { "X-Title": process.env.OPENROUTER_TITLE }
                  : {}),
              }
            : undefined,
      },
    ];
    let seededCreds = 0;
    for (const c of credSeed) {
      if (c.key) {
        const r = await sql`
          update providers set api_key = ${c.key}
          where id = ${c.id} and (api_key is null or api_key = '')
        `;
        seededCreds += r.count;
      }
      if (c.headers) {
        await sql`
          update providers set extra_headers = ${sql.json(c.headers)}
          where id = ${c.id} and extra_headers is null
        `;
      }
    }
    console.log(
      seededCreds > 0
        ? `✅ Copied ${seededCreds} provider key(s) from env → DB (env vars now unused, safe to remove).`
        : "✅ provider keys: nothing to copy (already set in DB or no env vars).",
    );

    // ─── Seed VixAI's catalog so bare names don't regress at cutover ──
    // Pre-overhaul, VixAI bare-name routing was driven by a hardcoded
    // VIXAI_BARE_MODELS set in registry.ts, and the public model list
    // showed those ids WITHOUT a prefix — so every existing JanitorAI
    // config has a bare id like "deepseek/deepseek-v4-pro" saved. The new
    // router resolves bare/legacy names via provider_models, so if that
    // table is empty for 'vx' the day we deploy, those configs would fall
    // through to the default provider and break. Seed exactly the old
    // set (display_name = upstream_id, no mask) so resolution is
    // unchanged on day one. Admins can hit "Refresh models" afterwards to
    // pull the live list + real owned_by and mask names as they like.
    //
    // Guarded: only seeds when 'vx' has NO model rows yet, so re-running
    // migrate never resurrects a model an admin later removed/disabled,
    // and never clobbers masks. OpenRouter is intentionally NOT seeded —
    // the old code had no bare-name routing for it, so there's nothing to
    // preserve; an admin populates it via "Add/Refresh" when needed.
    const VIXAI_SEED = [
      "deepseek-ai/DeepSeek-R1-0528",
      "deepseek-ai/DeepSeek-V3.1",
      "deepseek-ai/DeepSeek-V3.1-Terminus",
      "deepseek-ai/DeepSeek-V3.1-Terminus:thinking",
      "deepseek-ai/DeepSeek-V3.1:thinking",
      "deepseek-r1",
      "deepseek-v3-0324",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v3.2:thinking",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro:thinking",
      "z-ai/glm-4.6",
      "z-ai/glm-4.6:thinking",
      "zai-org/glm-4.7",
      "zai-org/glm-4.7:thinking",
      "zai-org/glm-5",
      "zai-org/glm-5.1",
      "zai-org/glm-5.1:thinking",
      "zai-org/glm-5:thinking",
    ];
    // Same vendor label the old vixai.ts vendorFromId() computed, so the
    // landing-page grouping ("deepseek" / "zai") is byte-identical to
    // before — the prefix is the ONLY user-visible change. "Refresh
    // models" later overwrites this with whatever the upstream reports.
    const vixaiVendor = (id: string): string => {
      const slash = id.indexOf("/");
      if (slash !== -1) {
        const raw = id.slice(0, slash);
        if (raw === "deepseek-ai" || raw === "deepseek") return "deepseek";
        if (raw === "zai-org" || raw === "z-ai") return "zai";
        return raw;
      }
      if (id.startsWith("deepseek-")) return "deepseek";
      return "auto";
    };
    const vxExists = await sql`select 1 from providers where id = 'vx'`;
    const vxHasModels = await sql`
      select 1 from provider_models where provider_id = 'vx' limit 1
    `;
    if (vxExists.count > 0 && vxHasModels.count === 0) {
      for (const mid of VIXAI_SEED) {
        await sql`
          insert into provider_models (provider_id, upstream_id, display_name, owned_by)
          values ('vx', ${mid}, ${mid}, ${vixaiVendor(mid)})
          on conflict (provider_id, upstream_id) do nothing
        `;
      }
      console.log(
        `✅ Seeded ${VIXAI_SEED.length} VixAI model(s) (back-compat — admins can Refresh/mask after).`,
      );
    } else {
      console.log(
        "✅ provider_models: nothing to seed (vx already has models or no vx row).",
      );
    }

    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('users', 'api_keys', 'request_logs', 'banned_users', 'action_logs', 'rate_limit_hits', 'vixai_limit_hits', 'app_config', 'providers', 'provider_models', 'tiers', 'tier_provider_limits', 'warming_logs')
      ORDER BY table_name
    `;
    console.log("Tables:");
    for (const t of tables) {
      console.log(`  ✓ ${t.table_name}`);
    }
  } catch (err) {
    console.error("❌ Schema setup failed:", (err as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
