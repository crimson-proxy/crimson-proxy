/**
 * Bulk-disable models on selected providers by name substring.
 *
 * Edit the PROVIDERS and NEEDLES constants below for each run.
 * Matching is case-insensitive substring on BOTH display_name and
 * upstream_id, so it catches branded names ("deepseek-v3",
 * "qwen2.5-72b") as well as the rare row where the admin masked the
 * display_name to something else but the upstream_id still carries
 * the brand.
 *
 * Idempotent: rows already disabled are filtered out so the count
 * reported reflects the actual change.
 *
 * Usage: edit constants, then `npx tsx scripts/disable-models.ts`.
 * Live registry caches for ~30s so allow that before checking
 * /v1/models or /status.
 */

import "dotenv/config";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.AIVEN_DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL.");
  process.exit(1);
}
const sql = postgres(DATABASE_URL, { ssl: "require", max: 1 });

const PROVIDERS = ["cre", "kat"];
const NEEDLES = ["deepseek", "gemma", "qwen", "codebuddy"];

const targets = await sql<
  { provider_id: string; display_name: string; upstream_id: string; enabled: boolean }[]
>`
  select provider_id, display_name, upstream_id, enabled
  from provider_models
  where provider_id in ${sql(PROVIDERS)}
    and (
      ${sql.unsafe(
        NEEDLES.map(
          (n) =>
            `lower(display_name) like '%${n}%' or lower(upstream_id) like '%${n}%'`,
        ).join(" or "),
      )}
    )
  order by provider_id, display_name
`;

console.log(`Found ${targets.length} matching model row(s):`);
for (const t of targets) {
  console.log(
    `  - ${t.provider_id}/${t.display_name}  (upstream=${t.upstream_id})  enabled=${t.enabled}`,
  );
}

const toDisable = targets.filter((t) => t.enabled);
if (toDisable.length === 0) {
  console.log("\nNothing to do — all matching rows are already disabled.");
  await sql.end();
  process.exit(0);
}

const result = await sql`
  update provider_models
  set enabled = false, updated_at = ${new Date().toISOString()}
  where provider_id in ${sql(PROVIDERS)}
    and enabled = true
    and (
      ${sql.unsafe(
        NEEDLES.map(
          (n) =>
            `lower(display_name) like '%${n}%' or lower(upstream_id) like '%${n}%'`,
        ).join(" or "),
      )}
    )
`;
console.log(`\nDisabled ${result.count} model row(s).`);
console.log(
  "Live registry caches for ~30s; allow that to expire before checking /v1/models.",
);

await sql.end();
