/**
 * Runtime-agnostic Hono app. Imported by:
 *   - src/server/server.ts (Node, for local dev — also leaves the door open
 *                           for long-running Node hosting later)
 *   - api/index.ts          (Vercel serverless function — current production)
 *
 * Add new routes here and they automatically work on both runtimes.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { requireApiKey } from "./middleware/auth.js";
import { appendLog } from "./lib/logs.js";
import admin from "./routes/admin.js";
import auth from "./routes/auth.js";
import chat from "./routes/chat.js";
import discord from "./routes/discord.js";
import health from "./routes/health.js";
import logs from "./routes/logs.js";
import models from "./routes/models.js";
import status from "./routes/status.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());

// Public routes (each handles its own auth):
//   /health           — uptime monitors
//   /api/status       — model-health board (last-N-requests strip per
//                       model). Gated by Discord OAuth session JWT;
//                       drives the visual /status dashboard page. The
//                       public surface for the same data is the Discord
//                       channel board (lib/discord-status.ts).
//   /discord/*        — Ed25519 signature verification
//   /api/admin/*      — admin JWT (password login)
//   /api/auth/*       — Discord OAuth (public by design)
//   /api/keys         — session JWT (verified inside the route)
//   /api/logs         — admin JWT (verified inside the route)
//   /api/models       — public model list
app.route("/", health);
app.route("/", status);
app.route("/", discord);
app.route("/", admin);
app.route("/", auth);
app.route("/", logs);

// /v1/* routes always require a valid user API key (no bypass).
app.use("/v1/*", requireApiKey);

app.route("/", models);
app.route("/", chat);

/**
 * Last-resort error wall. Any unhandled exception from any route lands
 * here; we log the real error to request_logs (admin-only) and the
 * console (host logs) and return a generic cat-themed message to the
 * user. Without this the user would see `err.message` raw — which is
 * an information leak (stack-trace-shaped strings from internal bugs).
 *
 * Mirrors the masking convention chat.ts uses for upstream errors:
 *   public: cat-themed string + status code only
 *   admin/host: full error in request_logs + console.error
 */
app.onError((err, c) => {
  console.error("[app] unhandled error:", err);
  // Best-effort log to request_logs so admins can debug from the
  // dashboard. Fire-and-forget; never block the response on logging.
  appendLog(c, {
    timestamp: Date.now(),
    method: c.req.method,
    endpoint: c.req.path,
    status: 500,
    duration: 0,
    error: err.message,
    errorType: "unhandled_error",
  });
  return c.json(
    {
      error: {
        message:
          "Nya... something broke on my end. Try again in a moment~",
        type: "internal_error",
        code: 500,
      },
    },
    500,
  );
});

/**
 * 404 wall. Generic cat-themed message — does NOT echo the requested
 * path back, since some clients probe sensitive routes (e.g. `/admin`,
 * `/.env`) and reflecting the path in the body just confirms the probe
 * landed somewhere. Status code (404) is enough.
 */
app.notFound((c) => {
  return c.json(
    {
      error: {
        message: "Nya? I don't know that route~",
        type: "not_found",
        code: 404,
      },
    },
    404,
  );
});

export default app;
