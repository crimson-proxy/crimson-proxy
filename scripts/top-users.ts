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
    select discord_username, count(*)::int as requests,
           count(*) filter (where status = 200)::int as ok,
           count(*) filter (where status >= 400)::int as errors,
           sum(coalesce(message_count, 0))::int as total_messages
    from request_logs
    where discord_username is not null
    group by discord_username
    order by requests desc
    limit 20
  `;
  console.log("Top users by request count:");
  console.log("rank | user                | total | ok   | errors | msgs");
  rows.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)} | ${String(r.discord_username).padEnd(20).slice(0, 20)} | ${String(r.requests).padStart(5)} | ${String(r.ok).padStart(4)} | ${String(r.errors).padStart(6)} | ${String(r.total_messages).padStart(4)}`,
    );
  });
  await sql.end();
}
main();
