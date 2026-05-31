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
  const rows = await sql`
    select model, count(*)::int as n
    from request_logs
    where model is not null
      and created_at >= now() - interval '7 days'
    group by model
    order by n desc
  `;
  console.log(`Distinct models in request_logs (last 7d): ${rows.length}\n`);
  for (const r of rows) console.log(`  ${String(r.n).padStart(5)}  ${r.model}`);
  await sql.end();
}
main();
