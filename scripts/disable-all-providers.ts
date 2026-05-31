/**
 * One-shot: flip every row in `providers` to enabled = false.
 *
 * After this runs:
 *   - `/v1/models` and `/api/models` return an empty list (the
 *     aggregator in src/server/routes/models.ts filters by
 *     providers.enabled).
 *   - `/v1/chat/completions` refuses every request with the
 *     "Provider X is disabled" path.
 *   - The admin Providers panel still shows every row, just toggled
 *     off — re-enable them individually when you want to come back.
 *
 * Note: registry/limit-config caches in the running server are 30s.
 * Allow up to ~30s after this script returns before users see the
 * effect on prod.
 *
 * Usage: npx tsx scripts/disable-all-providers.ts
 *
 * To re-enable, do it from the admin panel per-provider.
 */

import "dotenv/config";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.AIVEN_DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL or AIVEN_DATABASE_URL in env. Aborting.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { ssl: "require" });

async function main() {
  const before = await sql<{ id: string; display_name: string; enabled: boolean }[]>`
    select id, display_name, enabled from providers order by id
  `;

  if (before.length === 0) {
    console.log("No provider rows found. Nothing to do.");
    return;
  }

  console.log(`Found ${before.length} provider row(s):`);
  for (const p of before) {
    console.log(`  - ${p.id} (${p.display_name}) — enabled=${p.enabled}`);
  }

  const alreadyDisabled = before.filter((p) => p.enabled === false).length;
  if (alreadyDisabled === before.length) {
    console.log("\nAll providers are already disabled. Nothing to do.");
    return;
  }

  const result = await sql`update providers set enabled = false`;
  console.log(`\nDisabled ${result.count} provider row(s).`);
  console.log(
    "Live server caches for ~30s; allow that to expire before checking /v1/models.",
  );

  await sql.end();
}

main();
