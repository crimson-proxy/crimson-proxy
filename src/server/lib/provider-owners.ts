/**
 * Resolve "who added each provider" for display on /status and the
 * public landing page.
 *
 * One query against `providers`, one batched query against `users` for
 * the non-null owners. The mock provider is intentionally excluded
 * (no operator, never has an owner_id).
 *
 * The shape is intentionally minimal — only the fields the UI needs to
 * render an "added by [avatar] [name]" chip. `owner` is null when the
 * provider row's owner_id is null (older imports) or the user is
 * missing from the `users` table (unknown Discord id; this is rare
 * because ensureUserExists backfills them).
 *
 * Note: /api/models is a PUBLIC endpoint, so the username + avatar
 * surface to anonymous visitors. That's intentional — the user asked
 * for it explicitly so people can see who's responsible for which
 * prefix.
 */

import { getDb, hasDb } from "./db.js";
import { getUsersByIds } from "./users.js";

export type ProviderOwner = {
  /** Routing prefix users type ('pn', 'vx', …). The grouping key the
   *  homepage / /status page already buckets by. */
  prefix: string;
  /** Discord profile of whoever added the provider. null when
   *  owner_id is null or the user row is missing. */
  owner: { id: string; username: string; avatar: string | null } | null;
};

export async function loadProviderOwners(): Promise<ProviderOwner[]> {
  if (!hasDb()) return [];
  const sql = getDb();
  let rows: { id: string; prefix: string | null; owner_id: string | null }[];
  try {
    rows = await sql<{ id: string; prefix: string | null; owner_id: string | null }[]>`
      select id, prefix, owner_id from providers
    `;
  } catch {
    return [];
  }
  const ids = [
    ...new Set(rows.map((r) => r.owner_id).filter((v): v is string => Boolean(v))),
  ];
  const users = await getUsersByIds(ids);
  return rows
    .filter((r) => r.id !== "mock")
    .map((r) => {
      const u = r.owner_id ? users[r.owner_id] : null;
      return {
        prefix: r.prefix ?? r.id,
        owner: u
          ? { id: u.discordId, username: u.username, avatar: u.avatar }
          : null,
      };
    });
}
