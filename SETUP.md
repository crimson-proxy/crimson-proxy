# Setup Guide

This guide walks you through setting up Crimson's Proxy step by step. You don't
need to be a programmer — just follow along and copy/paste where shown. 🙂

If anything here doesn't make sense, the deeper technical reference is in
**[README.md](README.md)**.

---

## What you'll need before starting

You'll be collecting a handful of values (called *environment variables*) that
tell the app how to connect to Discord and to your database. Before you begin,
make sure you have:

1. **A Discord account**, and a Discord **server you manage** (you need the
   "Manage Server" permission).
2. **A database** — a free Postgres database works great. This project uses
   [Aiven](https://aiven.io), but any Postgres host is fine. You just need its
   **connection string** (a line that starts with `postgres://`).

The rest you'll create as you go. Take it one step at a time.

---

## Step 1 — Turn on Discord "Developer Mode"

Many of the values below are IDs you copy by right-clicking things in Discord.
To get the **"Copy ID"** option, turn this on once:

> **Discord → Settings (⚙️ gear icon) → Advanced → toggle "Developer Mode" ON.**

Now, right-clicking a server, channel, or role shows a **"Copy ID"** option.

---

## Step 2 — Create your settings file

The app reads its settings from a file called `.env`. A template named
`.env.example` is already included. Make a copy of it called `.env`:

```bash
cp .env.example .env
```

Then open `.env` and fill in the blanks using the guide below. Each line looks
like `NAME=` — type the value right after the `=` sign.

> ⚠️ **Keep `.env` private.** It holds passwords and secret keys. It's already
> set up to never be uploaded to GitHub — don't share it or paste it anywhere
> public.

---

## Step 3 — Fill in each value

### 🗄️ The database

| Setting | What to put |
|---|---|
| `DATABASE_URL` | The connection string from your database provider. It looks like `postgres://username:password@host:5432/dbname?sslmode=require`. Copy it exactly. |

### 🔐 The admin secret

| Setting | What to put |
|---|---|
| `ADMIN_SIGNING_SECRET` | Any long, random, secret string — it keeps admin logins secure. **Don't** reuse a password from elsewhere. Easiest way to make one: run `openssl rand -base64 32` in a terminal and paste the result. |

### 💬 Discord

All of these come from the **[Discord Developer Portal](https://discord.com/developers/applications)**.
Open it, click your application (or create one), then find each value:

| Setting | Where to find it |
|---|---|
| `DISCORD_APP_ID` | **General Information → Application ID** (click *Copy*). |
| `DISCORD_PUBLIC_KEY` | **General Information → Public Key.** |
| `DISCORD_BOT_TOKEN` | **Bot → Reset Token**, then copy the new token. (You only see it once — copy it right away.) |
| `DISCORD_CLIENT_SECRET` | **OAuth2 → Client Secret → Reset Secret**, then copy it. Needed for the website login. |
| `DISCORD_SERVER_ID` | Right-click your **server icon** in Discord → **Copy Server ID.** |
| `DISCORD_REQUIRED_ROLE_ID` | The role members must have to log into the dashboard. Server Settings → Roles → right-click the role → **Copy Role ID.** |
| `DISCORD_ADMIN_ROLE_IDS` | The role(s) that get **admin** access. Same steps as above. For more than one, separate with commas: `111,222`. |
| `DISCORD_STAFF_CHANNEL_ID` | *(Optional)* A channel where the bot posts alerts. Right-click the channel → **Copy Channel ID.** Leave blank to skip alerts. |

> 💡 You can leave `PORT` as it is (`3000`) unless someone tells you otherwise.

**One more Discord step so login works:** in the Developer Portal, go to
**OAuth2 → Redirects** and add your site's login address, e.g.
`https://your-site.com/login` (and `http://localhost:5173/login` for local
testing). Without this, the "Login with Discord" button won't work.

---

## Step 4 — Create the database tables

Once `DATABASE_URL` is filled in, set up the database with one command:

```bash
npm run migrate
```

You can run this again any time — it's safe and won't harm existing data.

---

## Step 5 — Start it up

To run the site on your own computer (or in a Codespace) for testing:

```bash
npm install         # first time only — downloads what the app needs
npm run dev:server  # starts the backend
npm run dev         # in a SECOND terminal — starts the website
```

Then open the address it prints (usually `http://localhost:5173`).

---

## ⚠️ Important if you inherited a site that's already live

The same values above also live in the **hosting dashboards** (Cloudflare and/or
Vercel), not just in `.env`. If you change a secret, it must be updated in
**every** place — or the live site can break.

👉 If you're not sure, **ask before changing any secret on the live site.** The
exact steps are in **[README.md](README.md)** under *"Env var sync rule."*

---

## Where to go next

- **Adding AI providers** (the upstreams that actually answer requests) is done
  from the **admin panel** in your browser — log in with Discord, then go to
  **Limits & Config → Providers**. No coding needed.
- For everything technical — hosting, deploying, how it all works — see
  **[README.md](README.md)**.

You're all set. 🎉
