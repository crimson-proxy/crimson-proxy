/**
 * Staff alert plumbing.
 *
 * Sends notifications to a configured Discord channel when something
 * operational happens that staff should know about. Today the only
 * trigger is "AI provider pool running low" — but the helper is generic
 * so future alerts (e.g. provider outage, budget threshold) can reuse it.
 *
 * ─── Why this is safe to call from hot paths ──────────────────────────
 * - Configuration missing (no bot token, no channel id) → silent no-op.
 * - Discord API failure → logged and swallowed. Callers never throw.
 *
 * No dedupe: the user explicitly wants staff pinged every time the pool
 * is low, because the only fix is for staff to add more accounts. If we
 * suppressed alerts, staff might think the situation resolved itself.
 * The trigger is `markCooldown`, which only fires when an account just
 * got rate-limited, so the volume is naturally bounded by how often
 * accounts actually drain.
 */

import { config } from "./config.js";
import { getAppConfig } from "./app-config.js";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Low-level: post a plain-text message to a Discord channel via the bot.
 * Returns true on success, false on any failure (logged). Never throws.
 */
async function postToChannel(channelId: string, content: string): Promise<boolean> {
  if (!config.discordBotToken || !channelId) return false;
  try {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[staff-notifier] Discord ${res.status}: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[staff-notifier] post failed:", (err as Error).message);
    return false;
  }
}

/**
 * Public alert helper. Posts to the configured staff channel if one is
 * set, otherwise no-op.
 */
export async function notifyStaff(content: string): Promise<void> {
  const { discordStaffChannelId } = await getAppConfig();
  if (!discordStaffChannelId) return;
  await postToChannel(discordStaffChannelId, content);
}

