/**
 * Centralized config reader. All env vars are read here so the rest of the
 * code never touches process.env directly. This keeps the code portable:
 * swap this module out (or override values) when running in tests, on Vercel,
 * or in a different runtime.
 */

function readEnv(name: string, fallback?: string): string {
  const val = process.env[name];
  if (val !== undefined && val !== "") return val;
  if (fallback !== undefined) return fallback;
  return "";
}



export const config = {
  // Server
  port: Number(readEnv("PORT", "3000")),

  // Admin panel. JWT signing secret for short-lived admin tokens.
  // Access is controlled by Discord roles (see discordAdminRoleIds).
  adminSigningSecret: readEnv("ADMIN_SIGNING_SECRET"),

  // Discord integration (for the /discord/interactions endpoint that
  // handles /get-api-key, /revoke-api-key, etc.).
  //
  // NOTE: discordServerId / discordRequiredRoleId / discordAdminRoleIds /
  // discordStaffChannelId are now the BOOTSTRAP FALLBACK only. At runtime
  // lib/app-config.ts reads these from the app_config table and the DB
  // value wins; env is used until the DB is seeded (and so dashboard
  // access still works on a fresh deploy). Read them via getAppConfig(),
  // not config.*, in request paths. Secrets (bot token, public key,
  // client secret) stay env-only and are still read directly here.
  discordAppId: readEnv("DISCORD_APP_ID"),
  discordPublicKey: readEnv("DISCORD_PUBLIC_KEY"),
  discordBotToken: readEnv("DISCORD_BOT_TOKEN"),
  discordServerId: readEnv("DISCORD_SERVER_ID"),
  discordRequiredRoleId: readEnv("DISCORD_REQUIRED_ROLE_ID"),
  discordAdminRoleIds: readEnv("DISCORD_ADMIN_ROLE_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  discordClientSecret: readEnv("DISCORD_CLIENT_SECRET"),
  // Staff-alert channel. Bootstrap fallback only — see note above; the
  // live value comes from app_config via getAppConfig().
  discordStaffChannelId: readEnv("DISCORD_STAFF_CHANNEL_ID"),

  // OpenAI-compatible providers (OpenRouter, anything an admin adds) are
  // configured from the `providers` DB table, not env. Managed from the
  // admin dashboard; providers/registry.ts loads them with a 30s cache.
};

export { readEnv };
