/**
 * Register Discord slash commands.
 *
 * Run once with: npm run register-discord
 *
 * This calls Discord's REST API to tell it about our commands. If you add
 * or rename a command, edit the COMMANDS array below and rerun this script.
 *
 * Guild-scoped registration (we pass DISCORD_SERVER_ID) means the commands
 * appear instantly in your server. Global registration would take up to an
 * hour to propagate, so we use guild-scoped during development. If you
 * later want the commands available in other servers too, remove the
 * /guilds/{id} part of the URL and re-run.
 *
 * Required env vars:
 *   DISCORD_APP_ID      Your Discord application's ID
 *   DISCORD_BOT_TOKEN   The bot token (used for auth on this admin call)
 *   DISCORD_SERVER_ID   Your server's ID (for guild-scoped registration)
 */

import "dotenv/config";
import { config } from "../src/server/lib/config.js";

const COMMANDS = [
  {
    name: "get-api-key",
    description: "Get your Crimson's Proxy API key. Only you can see the reply.",
    type: 1, // CHAT_INPUT (slash command)
  },
  {
    name: "regenerate-api-key",
    description: "Revoke your existing keys and issue a fresh one.",
    type: 1,
  },
  {
    name: "revoke-api-key",
    description: "Revoke all your active keys (without replacing them).",
    type: 1,
  },
  {
    name: "my-keys",
    description: "Show your active and revoked keys, with last-used timestamps.",
    type: 1,
  },
  {
    name: "models",
    description: "Show available AI models on Crimson's Proxy.",
    type: 1,
  },
  {
    name: "status",
    description: "Check your account status, active timeouts, or ban history.",
    type: 1,
  },
  {
    name: "health",
    description: "Show live AI model health (last 20 requests per model).",
    type: 1,
  },
];

async function main() {
  if (!config.discordAppId) {
    console.error("Missing DISCORD_APP_ID in .env");
    process.exit(1);
  }
  if (!config.discordBotToken) {
    console.error("Missing DISCORD_BOT_TOKEN in .env");
    process.exit(1);
  }
  if (!config.discordServerId) {
    console.error("Missing DISCORD_SERVER_ID in .env (required for guild-scoped install)");
    process.exit(1);
  }

  const url = `https://discord.com/api/v10/applications/${config.discordAppId}/guilds/${config.discordServerId}/commands`;

  console.log(`Registering ${COMMANDS.length} commands at ${url}`);

  // Bulk-overwrite: PUT replaces all guild commands with the array we send.
  // Easier than diffing additions/removals manually.
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Discord rejected the registration: ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  const data = (await res.json()) as Array<{ id: string; name: string }>;
  console.log("✅ Registered:");
  for (const cmd of data) console.log(`  /${cmd.name}  (id: ${cmd.id})`);
}

main().catch((err) => {
  console.error("unexpected error:", err);
  process.exit(1);
});
