/**
 * Read-only inspection of the discord status channel. Prints every
 * message the bot can see, oldest first, with a short summary so we
 * can confirm whether duplicates exist before doing anything.
 *
 * Throwaway. Bot must have View Channel + Read Message History on
 * the channel.
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
  const cfg = await sql<{ key: string; value: string }[]>`
    select key, value from app_config
    where key in ('discord_status_channel_id', 'discord_status_message_id')
  `;
  const channelId = cfg.find((r) => r.key === "discord_status_channel_id")?.value;
  const map = JSON.parse(
    cfg.find((r) => r.key === "discord_status_message_id")?.value ?? "{}",
  ) as Record<string, string>;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    console.error("Missing channel id or bot token.");
    await sql.end();
    return;
  }
  console.log(`channel: ${channelId}`);
  console.log(`map known to app_config:`);
  for (const [k, v] of Object.entries(map)) console.log(`  ${k}: ${v}`);
  console.log();

  // Pull the last 50 messages in the channel (newest first per discord).
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=50`,
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  if (!res.ok) {
    console.error(`discord ${res.status}: ${await res.text()}`);
    await sql.end();
    return;
  }
  const messages = (await res.json()) as Array<{
    id: string;
    author: { id: string; username: string; bot?: boolean };
    content: string;
    timestamp: string;
  }>;
  console.log(`channel has ${messages.length} recent messages (newest first):\n`);

  // Reverse so we read top-of-channel first.
  for (const m of messages.reverse()) {
    // Identify which header (if any) is on the first visible line of the body.
    const firstLine = m.content.split("\n", 1)[0];
    const knownAs = Object.entries(map).find(([, id]) => id === m.id)?.[0];
    const tag = knownAs ? `(map.${knownAs})` : "(NOT IN MAP)";
    console.log(
      `  ${m.id}  ${tag.padEnd(18)}  ${m.timestamp}  ${m.author.username}`,
    );
    console.log(`    first line: ${firstLine.slice(0, 60)}`);
  }
  await sql.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
