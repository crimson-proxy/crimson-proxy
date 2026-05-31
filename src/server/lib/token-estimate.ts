/**
 * Crude character-count token estimator.
 *
 * Used for providers that don't return real token counts from the API.
 * `chars / 4` is the rule of thumb everyone in the OpenAI ecosystem uses
 * for English-ish text — it's within ~20% for chat-style content. We
 * accept the error because the alternative is shipping a 2 MB tokenizer
 * binary to Vercel for a stat that's only used for reporting.
 *
 * For OpenAI-compatible providers (OpenRouter today) we read the real
 * `usage` field off the response instead.
 *
 * Empty string returns 0 so callers don't need to guard.
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
