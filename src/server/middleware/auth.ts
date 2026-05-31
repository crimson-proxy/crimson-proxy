/**
 * Bearer-token auth middleware for /v1/* routes.
 *
 * Reads `Authorization: Bearer <key>` from the request, looks it up in the
 * api_keys table, and either:
 *   - rejects with 401 if missing / unknown / revoked
 *   - attaches { keyId, discordUserId, discordUsername } to the Hono
 *     context so downstream code (logging, rate limiting later) knows who
 *     made the request
 *
 * Auth is UNCONDITIONAL — there is no bypass. (The old REQUIRE_AUTH=false
 * escape hatch was removed: a free public gateway is never an acceptable
 * state, not even in local dev.)
 *
 * Fail-closed cases:
 *   - Supabase isn't configured: return 503. A single typo in a Vercel
 *     env-var name must NOT turn the proxy into a free public OpenAI
 *     gateway. The runtime cost of a 503 here is "operator fixes the env
 *     var and redeploys"; the cost of fail-open is "upstream provider
 *     accounts drained."
 *
 *   - DB is configured but unreachable (e.g. Aiven connection cap hit,
 *     Hyperdrive exhausted): `lookupKey()` throws, we catch and return 503
 *     "something broke on my end". Users do NOT get told to regenerate
 *     their key — that was the old misleading behavior when the catch
 *     swallowed the error and returned null.
 */

import type { Context, MiddlewareHandler } from "hono";
import { lookupKey } from "../lib/api-keys.js";
import { getActiveBan } from "../lib/bans.js";
import { hasDb } from "../lib/db.js";

export type AuthContext = {
  keyId: number | null;
  discordUserId: string | null;
  discordUsername: string | null;
};

/** Get the auth info attached to the current request, or a null record. */
export function getAuth(c: Context): AuthContext {
  return (
    (c.get("auth") as AuthContext | undefined) ?? {
      keyId: null,
      discordUserId: null,
      discordUsername: null,
    }
  );
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  // Supabase is the api_keys store. Without it we cannot authenticate, so
  // fail closed (503) rather than ever letting a request through. The most
  // common trigger is a typo'd env var name on the deploy host (e.g.
  // SUPBASE_URL); the warn below surfaces that in function logs.
  if (!hasDb()) {
    console.warn(
      "[auth] SUPABASE_URL/SUPABASE_KEY are missing. " +
        "Refusing all /v1 requests until the env vars are set.",
    );
    return c.json(
      {
        error: {
          message:
            "Nya... I can't check your key right meow — something broke on my end. Try again in a few minutes, staff have been poked! 🙀",
          type: "service_unavailable",
        },
      },
      503,
    );
  }

  const token = parseBearer(c.req.header("Authorization"));
  if (!token) {
    return c.json(
      {
        error: {
          message:
            "Nya? You forgot your key! Send `Authorization: Bearer <your-key>`. Get one with /get-api-key in our Discord~",
          type: "missing_api_key",
        },
      },
      401,
    );
  }

  let record: Awaited<ReturnType<typeof lookupKey>>;
  try {
    record = await lookupKey(token);
  } catch {
    return c.json(
      {
        error: {
          message:
            "Nya... I can't check your key right meow — something broke on my end. Try again in a few minutes, staff have been poked! 🙀",
          type: "service_unavailable",
        },
      },
      503,
    );
  }
  if (!record) {
    return c.json(
      {
        error: {
          message:
            "Nya?! That key doesn't work — it's invalid or revoked. Run /regenerate-api-key in our Discord for a fresh one~",
          type: "invalid_api_key",
        },
      },
      401,
    );
  }

  // Even with a valid key, refuse the request if the owning user is
  // currently banned or on an active timeout. This is the real gate —
  // we don't rely on revokeAllForUser having run, because (a) it's a
  // side effect that could regress, and (b) we want to handle the case
  // where a user regenerates a key while an active ban exists in any
  // future code path.
  const ban = await getActiveBan(record.discordUserId);
  if (ban) {
    const expiresHint = ban.expiresAt
      ? ` You'll be free again at ${ban.expiresAt}.`
      : "";
    return c.json(
      {
        error: {
          message:
            `Nya... you're currently ${ban.expiresAt ? "on a timeout" : "banned"}.${expiresHint}` +
            ` Reason: ${ban.reason ?? "no reason given"}. 😿`,
          type: "user_banned",
        },
      },
      403,
    );
  }

  c.set("auth", {
    keyId: record.id,
    discordUserId: record.discordUserId,
    discordUsername: record.discordUsername,
  } satisfies AuthContext);

  await next();
};
