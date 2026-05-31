#!/usr/bin/env bash
# Runs ONCE, when the Codespace / devcontainer is first created
# (devcontainer.json -> postCreateCommand). Installs project deps plus the
# CLIs the day-to-day workflow needs but the base node image doesn't carry.
#
# Only `npm install` is treated as fatal — everything after is best-effort
# so one flaky install (network, a moved package name) can't leave you with
# a container that refuses to come up.

set -e

# ─── Project dependencies (wrangler ships here, used via npx) ──────────
npm install

# Below here: best-effort. A single failure logs a note and moves on.
set +e

# Build the dashboard so dist/ exists. `npm run dev:cf` (wrangler dev) requires
# it — wrangler.toml's assets binding points at dist/, so a fresh Codespace that
# never built fails with "assets.directory ... does not exist".
npm run build || echo "[post-create] build failed — run 'npm run build' before dev:cf"

# psql, so `psql "$DATABASE_URL"` works for DB inspection / manual migrations.
sudo apt-get update -y \
  && sudo apt-get install -y --no-install-recommends postgresql-client \
  || echo "[post-create] postgresql-client install failed — psql unavailable"

# Vercel deploy CLI. NOT a package.json dependency, so a fresh clone can't
# run `vercel --prod` without this global install.
npm install -g vercel || echo "[post-create] vercel CLI install failed"

# AI coding CLIs — optional tooling parity for whoever picks up the repo.
npm install -g @anthropic-ai/claude-code || echo "[post-create] claude-code install skipped"
npm install -g opencode-ai || echo "[post-create] opencode install skipped"

echo "[post-create] done"
