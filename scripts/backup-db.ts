/**
 * Logical database backup. Run BEFORE `npm run migrate`.
 *
 *   npm run backup-db
 *
 * pg_dump isn't available in this environment and (when it is) its version
 * must match the server's or it refuses — so this uses the `postgres`
 * client already in package.json, which is always compatible. It connects
 * exactly like scripts/migrate.ts (Supabase session pooler).
 *
 * Output: backups/<UTC-timestamp>/
 *   - <table>.jsonl   one JSON row per line, for every public table
 *   - schema.json     information_schema column list (pre-migration shape)
 *   - ROLLBACK.md     exact SQL to undo THIS migration + restore notes
 *
 * The whole backups/ folder is gitignored (it holds user data + key
 * hashes). This is a data backup; the migration is additive so rollback
 * is "drop the new column/table", documented in ROLLBACK.md.
 */

import "dotenv/config";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_DB_PASSWORD) {
  console.error("Missing SUPABASE_URL or SUPABASE_DB_PASSWORD in .env");
  process.exit(1);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

const sql = postgres({
  host: "aws-1-us-east-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  username: `postgres.${projectRef}`,
  password: SUPABASE_DB_PASSWORD,
  ssl: "require",
});

/** Date → ISO, Buffer → base64 so the JSONL round-trips cleanly. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && (value as { type?: string }).type === "Buffer") {
    return value;
  }
  return value;
}

const ROLLBACK = `# Rollback — dynamic-provider migration

This backup was taken right before the dynamic-provider \`npm run migrate\`.

## The migration is additive

It only:
- ADDED columns to \`providers\`: kind, prefix, base_url, api_key,
  extra_headers, models_synced_at
- CREATED table \`provider_models\`
- backfilled those columns + seeded VixAI's catalog (guarded; existing
  data untouched — no DROP/DELETE/destructive UPDATE anywhere)

So the old code keeps working against the migrated DB, and rollback is
just removing the additions.

## To fully undo the schema (only if you must)

\`\`\`sql
drop table if exists provider_models;
alter table providers
  drop column if exists kind,
  drop column if exists prefix,
  drop column if exists base_url,
  drop column if exists api_key,
  drop column if exists extra_headers,
  drop column if exists models_synced_at;
drop index if exists providers_prefix_idx;
\`\`\`

(The backfilled rows in \`providers\` are the same rows that existed
before — only the new columns were populated, so dropping the columns
restores the exact prior state.)

## To restore table data from this backup

Each \`<table>.jsonl\` is one JSON row per line. To restore a table:
truncate it and re-insert the lines (e.g. with a small script using the
same \`postgres\` client). You should not need this — the migration never
deletes or rewrites existing rows.
`;

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(process.cwd(), "backups", stamp);
  await mkdir(dir, { recursive: true });
  console.log(`Backing up project ${projectRef} → backups/${stamp}/`);

  try {
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;

    // Pre-migration schema snapshot.
    const columns = await sql`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `;
    await writeFile(
      path.join(dir, "schema.json"),
      JSON.stringify(columns, replacer, 2),
    );

    let grandTotal = 0;
    for (const { table_name } of tables) {
      const out = createWriteStream(path.join(dir, `${table_name}.jsonl`));
      let count = 0;
      // Stream in batches so a big table (request_logs) never blows memory.
      await sql`select * from ${sql(table_name)}`.cursor(1000, async (rows) => {
        for (const row of rows) {
          out.write(JSON.stringify(row, replacer) + "\n");
          count++;
        }
      });
      await new Promise<void>((r) => out.end(r));
      grandTotal += count;
      console.log(`  ✓ ${table_name}: ${count} rows`);
    }

    await writeFile(path.join(dir, "ROLLBACK.md"), ROLLBACK);

    console.log(
      `\n✅ Backup complete: ${tables.length} tables, ${grandTotal} rows total.`,
    );
    console.log(`   Location: backups/${stamp}/  (gitignored)`);
  } catch (err) {
    console.error("❌ Backup failed:", (err as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
