/**
 * Discord OAuth session JWT verification helper.
 *
 * Used by every route that needs to know "is this an authenticated
 * dashboard user?" (the Discord OAuth flow stashes a JWT in the
 * client's localStorage and the dashboard sends it as
 * `Authorization: Bearer <jwt>` on /api/* calls).
 *
 * Distinct from:
 *   - middleware/auth.ts `requireApiKey`  → validates a `crp_...` API
 *     key for /v1/* OpenAI-compatible traffic; that's machine-to-
 *     machine, this is the human dashboard session.
 *   - routes/admin.ts `requireAdmin`     → validates the short-lived
 *     admin JWT minted by /api/admin/login after a session-JWT +
 *     Discord-role check; that's a different token entirely.
 *
 * Originally lived inside routes/auth.ts as a private function. Moved
 * here so routes/status.ts can gate /api/status without re-implementing
 * the verification.
 */

import { jwtVerify } from "jose";
import { config } from "./config.js";

function signingKey(): Uint8Array {
  return new TextEncoder().encode(config.adminSigningSecret);
}

/**
 * Extract and verify a session JWT from an `Authorization` header.
 * Returns the user payload on success or null on any failure (missing
 * header, malformed Bearer, bad signature, wrong token type, expired).
 *
 * Caller responsibility: turn null into 401. This helper deliberately
 * doesn't throw — every route that uses it has the same pattern:
 *   const user = await getSessionUser(c.req.header("Authorization"));
 *   if (!user) return c.json({ error: "Not authenticated" }, 401);
 */
export async function getSessionUser(
  header: string | undefined,
): Promise<{ sub: string; username: string; avatar: string | null } | null> {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1].trim(), signingKey(), {
      algorithms: ["HS256"],
    });
    if (payload.type !== "session" || !payload.sub) return null;
    return {
      sub: payload.sub,
      username: (payload.username as string) ?? "",
      avatar: (payload.avatar as string) ?? null,
    };
  } catch {
    return null;
  }
}
