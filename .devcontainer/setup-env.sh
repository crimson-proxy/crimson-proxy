#!/usr/bin/env bash
# Runs on EVERY container start (devcontainer.json -> postStartCommand).
# Regenerates .env and .dev.vars from the environment. In a Codespace those
# values come from your Codespaces secrets:
#   GitHub -> Settings -> Codespaces -> Repository secrets
# so no secret is ever committed — the files are rebuilt locally each start.
#
# The one value that actually matters for the app to function is
# DATABASE_URL; if it's missing we warn loudly (dev:cf will 503 until set).

set -u
cd "$(dirname "$0")/.."   # repo root

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[setup-env] WARNING: DATABASE_URL is not set."
  echo "[setup-env]   Add it under GitHub -> Settings -> Codespaces -> Repository"
  echo "[setup-env]   secrets, then rebuild the Codespace. dev:cf will 503 until then."
fi

# The wrangler-local Hyperdrive var mirrors DATABASE_URL (see
# .dev.vars.example) — wrangler dev can't reach the real edge Hyperdrive,
# so it points at the same Postgres URL. Auto-mirror it if not set so the
# dev only has to provide DATABASE_URL.
: "${CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:=${DATABASE_URL:-}}"

# Functional secrets shared by every runtime.
COMMON=(ADMIN_SIGNING_SECRET DATABASE_URL DISCORD_APP_ID DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN DISCORD_SERVER_ID DISCORD_REQUIRED_ROLE_ID
  DISCORD_ADMIN_ROLE_IDS DISCORD_CLIENT_SECRET DISCORD_STAFF_CHANNEL_ID)

# .env — read by npm run dev:server / migrate (Node entry also reads PORT).
{
  printf 'PORT=%s\n' "${PORT:-3000}"
  for name in "${COMMON[@]}"; do printf '%s=%s\n' "$name" "${!name:-}"; done
} > .env

# .dev.vars — read by npm run dev:cf. Mirrors .env (minus PORT) plus the
# wrangler-local Hyperdrive connection string.
{
  for name in "${COMMON[@]}"; do printf '%s=%s\n' "$name" "${!name:-}"; done
  printf 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=%s\n' \
    "${CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:-}"
} > .dev.vars

echo "[setup-env] wrote .env and .dev.vars from environment"
