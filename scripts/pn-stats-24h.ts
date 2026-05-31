/**
 * Ad-hoc: top 5 users by request count and top 5 by total tokens
 * for the `pn` provider in the last 24 hours, joined with the users table.
 */
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
  // Sanity: total pn rows in last 24h
  const [{ total }] = await sql<{ total: number }[]>`
    select count(*)::int as total
    from request_logs
    where via = 'pn'
      and created_at >= now() - interval '24 hours'
  `;
  console.log(`\nTotal pn requests in last 24h: ${total}\n`);

  const topRequests = await sql`
    select
      r.discord_user_id,
      coalesce(u.username, r.discord_username, '(unknown)') as username,
      count(*)::int as requests,
      count(*) filter (where r.status = 200)::int as ok,
      count(*) filter (where r.status >= 400)::int as errors,
      coalesce(sum(r.total_tokens), 0)::bigint as total_tokens
    from request_logs r
    left join users u on u.discord_id = r.discord_user_id
    where r.via = 'pn'
      and r.created_at >= now() - interval '24 hours'
    group by r.discord_user_id, u.username, r.discord_username
    order by requests desc
    limit 5
  `;

  console.log("Top 5 users by REQUEST COUNT (pn, last 24h):");
  console.log("rank | user                 | discord_id           | reqs | ok   | err  | tokens");
  topRequests.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)} | ${String(r.username).padEnd(20).slice(0, 20)} | ${String(r.discord_user_id ?? "(none)").padEnd(20).slice(0, 20)} | ${String(r.requests).padStart(4)} | ${String(r.ok).padStart(4)} | ${String(r.errors).padStart(4)} | ${String(r.total_tokens).padStart(6)}`,
    );
  });

  const topTokens = await sql`
    select
      r.discord_user_id,
      coalesce(u.username, r.discord_username, '(unknown)') as username,
      count(*)::int as requests,
      coalesce(sum(r.prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(r.completion_tokens), 0)::bigint as completion_tokens,
      coalesce(sum(r.total_tokens), 0)::bigint as total_tokens
    from request_logs r
    left join users u on u.discord_id = r.discord_user_id
    where r.via = 'pn'
      and r.created_at >= now() - interval '24 hours'
      and r.total_tokens is not null
    group by r.discord_user_id, u.username, r.discord_username
    order by total_tokens desc
    limit 5
  `;

  console.log("\nTop 5 users by TOTAL TOKENS (pn, last 24h):");
  console.log("rank | user                 | discord_id           | reqs | prompt | comp   | total");
  topTokens.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)} | ${String(r.username).padEnd(20).slice(0, 20)} | ${String(r.discord_user_id ?? "(none)").padEnd(20).slice(0, 20)} | ${String(r.requests).padStart(4)} | ${String(r.prompt_tokens).padStart(6)} | ${String(r.completion_tokens).padStart(6)} | ${String(r.total_tokens).padStart(6)}`,
    );
  });

  await sql.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
