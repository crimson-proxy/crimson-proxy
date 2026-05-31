import "dotenv/config";
import postgres from "postgres";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_DB_PASSWORD) {
  console.error("Missing SUPABASE_URL or SUPABASE_DB_PASSWORD");
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

const RPC = `
CREATE OR REPLACE FUNCTION get_user_stats(search_query text DEFAULT '')
RETURNS TABLE(
  discord_id text,
  username text,
  avatar text,
  total_requests bigint,
  error_requests bigint,
  last_request timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.discord_id,
    u.username,
    u.avatar,
    COUNT(r.id)::bigint as total_requests,
    COUNT(r.id) FILTER (WHERE r.status >= 400)::bigint as error_requests,
    MAX(r.created_at) as last_request
  FROM users u
  LEFT JOIN request_logs r ON u.discord_id = r.discord_user_id
  WHERE search_query = '' OR u.username ILIKE '%' || search_query || '%' OR u.discord_id = search_query
  GROUP BY u.discord_id, u.username, u.avatar;
END;
$$ LANGUAGE plpgsql;
`;

async function main() {
  try {
    await sql.unsafe(RPC);
    console.log("✅ RPC get_user_stats created successfully.");
  } catch (err) {
    console.error("❌ Failed:", (err as Error).message);
  } finally {
    await sql.end();
  }
}
main();
