import "dotenv/config";
import postgres from "postgres";

const projectRef = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
const sql = postgres({
  host: "aws-1-us-east-1.pooler.supabase.com",
  port: 5432,
  database: "postgres",
  username: `postgres.${projectRef}`,
  password: process.env.SUPABASE_DB_PASSWORD!,
  ssl: "require",
});

async function main() {
  const errs = await sql`
    select status, endpoint, error_type, error, discord_username, created_at
    from request_logs
    where status >= 400
    order by created_at desc limit 20
  `;
  console.log(`Recent ${errs.length} error responses:`);
  for (const e of errs) {
    console.log(`  ${e.created_at.toISOString()} ${e.endpoint} -> ${e.status} type=${e.error_type ?? "-"} user=${e.discord_username ?? "-"}`);
    if (e.error) console.log(`    error: ${e.error.slice(0, 200)}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
