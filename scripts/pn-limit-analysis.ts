/**
 * Ad-hoc: characterize pn usage to inform free-tier limit recommendations.
 * - Current configured limits on the pn provider
 * - Per-user distribution (last 24h + last 7d for context)
 * - Per-request size distribution (tokens, messages)
 * - Peak-minute / peak-hour bursts (for RPM sanity)
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
  const provider = await sql`
    select id, display_name, enabled,
           per_user_rpm, per_user_rpd, per_user_tpd,
           global_rpm,   global_rpd,   global_tpd
    from providers where id = 'pn'
  `;
  console.log("\n── Current pn provider config ──");
  console.log(provider[0] ?? "(no row found for id='pn')");

  console.log("\n── Per-user distribution, last 24h ──");
  const dist24 = await sql`
    with per_user as (
      select discord_user_id,
             count(*)::int as reqs,
             coalesce(sum(total_tokens),0)::bigint as tokens
      from request_logs
      where via = 'pn' and created_at >= now() - interval '24 hours'
      group by discord_user_id
    )
    select count(*)::int as users,
           sum(reqs)::int as total_reqs,
           sum(tokens)::bigint as total_tokens,
           percentile_cont(0.5) within group (order by reqs)::int   as p50_reqs,
           percentile_cont(0.9) within group (order by reqs)::int   as p90_reqs,
           max(reqs) as max_reqs,
           percentile_cont(0.5) within group (order by tokens)::bigint as p50_tokens,
           percentile_cont(0.9) within group (order by tokens)::bigint as p90_tokens,
           max(tokens) as max_tokens
    from per_user
  `;
  console.log(dist24[0]);

  console.log("\n── Per-user distribution, last 7d ──");
  const dist7 = await sql`
    with per_user as (
      select discord_user_id, date_trunc('day', created_at) as day,
             count(*)::int as reqs,
             coalesce(sum(total_tokens),0)::bigint as tokens
      from request_logs
      where via = 'pn' and created_at >= now() - interval '7 days'
      group by discord_user_id, date_trunc('day', created_at)
    )
    select count(*)::int as user_days,
           percentile_cont(0.5) within group (order by reqs)::int   as p50_reqs_per_day,
           percentile_cont(0.9) within group (order by reqs)::int   as p90_reqs_per_day,
           percentile_cont(0.99) within group (order by reqs)::int  as p99_reqs_per_day,
           max(reqs) as max_reqs_per_day,
           percentile_cont(0.5) within group (order by tokens)::bigint as p50_tokens_per_day,
           percentile_cont(0.9) within group (order by tokens)::bigint as p90_tokens_per_day,
           percentile_cont(0.99) within group (order by tokens)::bigint as p99_tokens_per_day,
           max(tokens) as max_tokens_per_day
    from per_user
  `;
  console.log(dist7[0]);

  console.log("\n── Per-request size, last 24h ──");
  const reqSize = await sql`
    select
      percentile_cont(0.5)  within group (order by total_tokens)::bigint as p50,
      percentile_cont(0.9)  within group (order by total_tokens)::bigint as p90,
      percentile_cont(0.99) within group (order by total_tokens)::bigint as p99,
      max(total_tokens) as max,
      avg(total_tokens)::int as avg
    from request_logs
    where via = 'pn' and created_at >= now() - interval '24 hours'
      and total_tokens is not null
  `;
  console.log(reqSize[0]);

  console.log("\n── Burstiness: peak per-user RPM (last 7d) ──");
  const burst = await sql`
    with per_min as (
      select discord_user_id, date_trunc('minute', created_at) as min,
             count(*)::int as reqs
      from request_logs
      where via = 'pn' and created_at >= now() - interval '7 days'
      group by discord_user_id, date_trunc('minute', created_at)
    )
    select percentile_cont(0.9)  within group (order by reqs)::int as p90,
           percentile_cont(0.99) within group (order by reqs)::int as p99,
           max(reqs) as max_per_user_per_min
    from per_min
  `;
  console.log(burst[0]);

  console.log("\n── Top heavy hitters per day, last 7d (top 10) ──");
  const heavy = await sql`
    select date_trunc('day', r.created_at)::date as day,
           coalesce(u.username, r.discord_username, '(unknown)') as user,
           count(*)::int as reqs,
           coalesce(sum(r.total_tokens),0)::bigint as tokens
    from request_logs r
    left join users u on u.discord_id = r.discord_user_id
    where r.via = 'pn' and r.created_at >= now() - interval '7 days'
    group by 1, 2
    order by tokens desc
    limit 10
  `;
  heavy.forEach((r) => {
    console.log(`  ${r.day.toISOString().slice(0,10)}  ${String(r.user).padEnd(22).slice(0,22)}  reqs=${String(r.reqs).padStart(4)}  tokens=${r.tokens}`);
  });

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
