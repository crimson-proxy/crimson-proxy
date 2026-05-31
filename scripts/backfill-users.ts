/**
 * One-time backfill: populate the `users` table from existing Discord
 * members. Fetches all unique discord_user_ids from api_keys, resolves
 * their profiles from Discord, and upserts into the users table.
 *
 * Usage: npx tsx scripts/backfill-users.ts
 */

import "dotenv/config";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.AIVEN_DATABASE_URL;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_SERVER_ID!;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL or AIVEN_DATABASE_URL");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { ssl: "require" });

async function main() {
  const keys = await sql<{ discord_user_id: string }[]>`
    select distinct discord_user_id
    from api_keys
    where discord_user_id is not null
  `;
  const ids = keys.map((k) => k.discord_user_id);
  console.log(`Found ${ids.length} unique user(s) to backfill:`, ids);

  let success = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const res = await fetch(
        `https://discord.com/api/guilds/${GUILD_ID}/members/${id}`,
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } },
      );

      if (!res.ok) {
        console.warn(`  ⚠ ${id}: Discord API returned ${res.status} (maybe left the server)`);
        failed++;
        continue;
      }

      const member = (await res.json()) as {
        user: { id: string; username: string; global_name?: string; avatar?: string };
      };

      const username = member.user.global_name ?? member.user.username;
      const avatar = member.user.avatar ?? null;

      try {
        await sql`
          insert into users (discord_id, username, avatar, updated_at)
          values (${id}, ${username}, ${avatar}, ${new Date().toISOString()})
          on conflict (discord_id) do update
            set username = excluded.username,
                avatar = excluded.avatar,
                updated_at = excluded.updated_at
        `;
        console.log(`  ✓ ${id} → ${username} (avatar: ${avatar ?? "none"})`);
        success++;
      } catch (err) {
        console.error(`  ✗ ${id} (${username}): DB error:`, (err as Error).message);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ ${id}: fetch error:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`\nDone: ${success} upserted, ${failed} failed.`);
  await sql.end();
}

main();
