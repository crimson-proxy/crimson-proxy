import { Hono } from "hono";
import { stream } from "hono/streaming";
import { appendLog } from "../lib/logs.js";
import { runInBackground } from "../lib/background.js";
import { getLimitConfig } from "../lib/limits.js";
import { checkUsage, type UsageResult } from "../lib/usage-limit.js";
import { estimateTokens } from "../lib/token-estimate.js";
import { refreshStatusBoard } from "../lib/discord-status.js";
import { maybeWarm, maybePrune } from "../lib/warmer.js";
import { getAuth } from "../middleware/auth.js";
import { resolveModel } from "../providers/registry.js";
import {
  ProviderError,
  type ChatRequest,
  type ProviderMeta,
} from "../providers/types.js";

type UsageBlocked = Extract<UsageResult, { allowed: false }>;

/**
 * Reconstruct a usage object for the abort/error path so a stopped stream
 * still counts toward TPD. The provider sets meta.usage when it finalizes
 * (success, or stream-close it caught) — use that. On a hard client abort
 * it may not have; we don't hold the partial output here (the provider
 * does), but the prompt is the bulk of RP traffic, so estimate it (chars/4,
 * same rule as token-estimate.ts) rather than logging zero tokens.
 */
function ensureUsage(
  meta: ProviderMeta,
  messages: ChatRequest["messages"],
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  if (meta.usage) return meta.usage;
  const prompt = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  return { prompt_tokens: prompt, completion_tokens: 0, total_tokens: prompt };
}

/** User-facing 429 text. Never names the provider (AI.md rule 6). */
function usageMessage(u: UsageBlocked): string {
  if (u.metric === "rpm") {
    return `Nya... too fast right meow! Slow down and try again in ${u.retryAfterSeconds}s~`;
  }
  const hrs = Math.ceil(u.retryAfterSeconds / 3600);
  if (u.metric === "rpd") {
    return `Nya~ you've used all ${u.limit} of your requests for today! Resets at 00:00 UTC, in ~${hrs}h~`;
  }
  return `Nya~ you've hit your daily token limit (${u.limit.toLocaleString()} tokens)! Resets at 00:00 UTC, in ~${hrs}h~`;
}

/** Internal log line (staff-only dashboards, so scope/metric is fine). */
function usageLogText(u: UsageBlocked): string {
  return `usage limit ${u.scope}/${u.metric}: ${u.used}/${u.limit}`;
}

const chat = new Hono();

/**
 * Map a status code to a user-safe, cat-themed error message.
 *
 * The real upstream error message (including provider name and any
 * implementation details) gets recorded in request_logs for debugging,
 * but never reaches the client. The client just sees the HTTP status
 * code plus a friendly explanation.
 */
function maskedMessage(status: number): string {
  if (status === 400) return "Nya? Your request looks wrong. Check the model name and messages~";
  if (status === 401) return "Nya? Your API key is missing or invalid~";
  if (status === 403) return "Nya? You're not allowed to use this. Contact an admin~";
  if (status === 404) return "Nya? Model not found. Run `/models` in Discord to see what's available~";
  if (status === 413) return "Nya... your context is too big. Try lowering your context size or trimming history turns~";
  if (status === 422) return "Nya?! Something in your context got flagged as unsafe by the model's safety filter — it might not even be your latest message, it could be your system prompt or earlier history. Try editing those~";
  if (status === 429) return "Nya... too many requests right meow! Slow down a bit~";
  if (status === 502) return "Nya... the proxy is having a hiccup. Try again in a moment~";
  if (status === 503) return "Nya... the proxy is overloaded right meow. Try again in a moment~";
  if (status === 504) return "Nya... that took too long. Try again with a shorter prompt~";
  return "Nya... something broke on my end. Try again in a moment~";
}

/**
 * Translate an upstream ProviderError status to the right status to
 * return to the client.
 *
 * The provider hands us the raw upstream status (e.g. 401 when an
 * upstream credential was rejected, or 403 when an account is out of credits).
 * Those are NOT the client's fault — the client's API key is the
 * Crimson Proxy key, validated at the auth middleware. If we passed
 * those statuses through verbatim, the client would see "401 your API
 * key is invalid" and start regenerating their proxy key, which fixes
 * nothing.
 *
 * Rules:
 *   - 401 / 403 / 502 / 503 from upstream → 502 Bad Gateway (proxy's
 *     fault, the user should NOT regenerate their key)
 *   - 429 from upstream → 503 Service Unavailable (we ran out of
 *     accounts to try right now; user should back off, not regenerate)
 *   - 504 / network errors / generic 500s → 504 (timeout) or 502
 *   - 400 / 404 / 422 (client-driven content / model errors) → passthrough,
 *     the user's request really IS wrong and the original messaging is
 *     accurate
 */
function statusForClient(upstream: number): number {
  if (upstream === 401 || upstream === 403) return 502;
  if (upstream === 429) return 503;
  if (upstream === 502 || upstream === 503) return 502;
  if (upstream === 504) return 504;
  if (upstream >= 500) return 502;
  // 400 / 404 / 413 / 422 — client-driven, passthrough.
  return upstream;
}

/**
 * Build a user-safe error payload. Drops provider names and upstream
 * error text. Same shape as OpenAI's error format minus `provider`.
 */
function maskedError(status: number) {
  return {
    error: {
      message: maskedMessage(status),
      type: "proxy_error",
      code: status,
    },
  };
}

/**
 * Disabled-provider rejection payload. Same OpenAI error shape as
 * maskedError but with a phrase that makes it clear the model is
 * unavailable (admin-toggled), not that the proxy is overloaded —
 * which is what the generic 503 message implies. Never names the
 * provider (AI.md rule 6).
 */
function disabledProviderError() {
  return {
    error: {
      message:
        "Nya... that model isn't available right meow. Try a different one~",
      type: "proxy_error",
      code: 503,
    },
  };
}

chat.post("/v1/chat/completions", async (c) => {
  const startTime = Date.now();
  const auth = getAuth(c);

  const body = (await c.req.json().catch(() => ({}))) as Partial<ChatRequest> & {
    model?: string;
  };

  const { model, messages, stream: wantStream = false } = body;

  if (!model) {
    return c.json(maskedError(400), 400);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return c.json(maskedError(400), 400);
  }

  // Resolve the model to a provider + the exact id to forward upstream.
  // The user-supplied `model` may be a prefixed name (vx/foo), a masked
  // display name, a raw upstream id, or a bare/legacy name — resolveModel
  // handles all of them (see providers/registry.ts). Errors here are
  // user-facing: unknown default provider, missing credentials, etc.
  let provider;
  let upstreamId: string;
  try {
    ({ provider, upstreamId } = await resolveModel(model));
  } catch (err) {
    if (err instanceof ProviderError) {
      appendLog(c, {
        timestamp: Date.now(),
        method: "POST",
        endpoint: "/v1/chat/completions",
        status: err.status,
        duration: Date.now() - startTime,
        model,
        error: err.message,
        errorType: "routing_error",
        discordUserId: auth.discordUserId,
        discordUsername: auth.discordUsername,
      });
      return c.json(maskedError(err.status), err.status as 400);
    }
    throw err;
  }

  // Admin-toggled provider disable. The Providers panel writes
  // providers.enabled in Supabase; getLimitConfig() caches that for 30s
  // and admin writes call invalidateLimitConfig(). When a provider is
  // marked disabled we reject with 503 *before* hitting the usage gate
  // or upstream — so users see a clear "model unavailable" message
  // instead of consuming quota or producing an upstream error. The
  // provider name still goes into the staff log (same convention as
  // usageLogText), only the user-facing message hides it.
  const limitCfg = await getLimitConfig();
  const providerCfg = limitCfg.providers.get(provider.id);
  if (providerCfg && providerCfg.enabled === false) {
    appendLog(c, {
      timestamp: Date.now(),
      method: "POST",
      endpoint: "/v1/chat/completions",
      status: 503,
      duration: Date.now() - startTime,
      model,
      // No `via`: the request never reached the provider, so it must
      // not count toward provider-scoped usage gates (same reasoning
      // as the rate_limited branch below).
      error: `provider '${provider.id}' is disabled`,
      errorType: "provider_disabled",
      discordUserId: auth.discordUserId,
      discordUsername: auth.discordUsername,
    });
    return c.json(disabledProviderError(), 503);
  }

  // Unified per-user usage limit (tier + provider aware; numbers resolved
  // from the DB by lib/usage-limit.ts). Authenticated users only —
  // anonymous requests can't be per-user capped. Runs after the provider
  // is known so the per-provider gates apply. Ban/timeout is already
  // enforced upstream by requireApiKey, so we don't re-check it here.
  if (auth.discordUserId) {
    const u = await checkUsage(auth.discordUserId, provider.id);
    if (!u.allowed) {
      // Pin the narrowing locally. TS narrows `u` to UsageBlocked inside
      // this branch on modern compilers, but Vercel's bundler-side type
      // check has been less reliable about it — the explicit cast makes
      // the build log clean regardless of which TS version runs there.
      const blocked = u as UsageBlocked;
      appendLog(c, {
        timestamp: Date.now(),
        method: "POST",
        endpoint: "/v1/chat/completions",
        status: 429,
        duration: Date.now() - startTime,
        model,
        // Deliberately NO `via`: a limiter rejection never reached the
        // provider, so usage-limit's via-filter must skip it. Setting it
        // would let a blocked user keep adding rows that count against
        // their own quota and never recover within the window.
        error: usageLogText(blocked),
        errorType: "rate_limited",
        discordUserId: auth.discordUserId,
        discordUsername: auth.discordUsername,
      });
      c.header("Retry-After", String(blocked.retryAfterSeconds));
      return c.json(
        {
          error: {
            message: usageMessage(blocked),
            type: "rate_limited",
            code: 429,
          },
        },
        429,
      );
    }
  }

  // Forward the resolved upstream id, not the user's string. The registry
  // already un-masked display names and stripped the routing prefix, so
  // the provider gets exactly the id its upstream expects. `model` (the
  // original user string) is still what we log, so request_logs reflects
  // what the client actually asked for.
  const req: ChatRequest = { ...(body as ChatRequest), model: upstreamId };

  // Provider out-param. Filled in as the provider runs; we read it back
  // before each appendLog call so token usage and which upstream account
  // served the request land in request_logs. Providers without a multi-
  // account pool simply leave accountId / accountLabel unset.
  const meta: ProviderMeta = {};

  // Streaming branch.
  //
  // We send an immediate SSE comment line as soon as the response headers
  // are flushed, then keepalive pings every ~5s while we wait for the
  // upstream's first byte. This prevents idle-timeout disconnects from
  // clients that abort if no bytes arrive within ~10-30s (Claude Code,
  // OpenCode, some browsers behind aggressive proxies). The comment lines
  // are SSE-spec ignored by parsers, so they don't show up as chunks on
  // the client side.
  if (wantStream) {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no"); // disable nginx response buffering

    return stream(c, async (s) => {
      // Initial flush so the client sees the connection is alive even
      // before the first real chunk.
      await s.write(": connected\n\n");

      // Heartbeat loop. setInterval is fine here; we clear it as soon as
      // the upstream starts producing real chunks or we hit an error.
      let firstChunkSeen = false;
      const heartbeat = setInterval(() => {
        if (firstChunkSeen) return;
        // SSE comment, ignored by clients. Just keeps the socket warm.
        s.write(": ping\n\n").catch(() => {});
      }, 5000);

      try {
        for await (const chunk of provider.stream(req, meta)) {
          firstChunkSeen = true;
          await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        clearInterval(heartbeat);
        await s.write("data: [DONE]\n\n");

        appendLog(c, {
          timestamp: Date.now(),
          method: "POST",
          endpoint: "/v1/chat/completions",
          status: 200,
          duration: Date.now() - startTime,
          model,
          messageCount: messages.length,
          via: provider.id,
          discordUserId: auth.discordUserId,
          discordUsername: auth.discordUsername,
          promptTokens: meta.usage?.prompt_tokens,
          completionTokens: meta.usage?.completion_tokens,
          totalTokens: meta.usage?.total_tokens,
          accountId: meta.accountId,
          accountLabel: meta.accountLabel,
        });
        // Background: refresh the Discord status board if one is
        // configured (internally throttled to one PATCH per 5 minutes),
        // and run the warmer/pruner.
        //
        // Routed through runInBackground so the work survives past the
        // response on serverless. Plain fire-and-forget here means
        // Cloudflare reaps the I/O context the instant the response
        // returns, so the warmer's upstream `fetch` blows up with
        // "Cannot perform I/O on behalf of a different request" — that
        // killed warming_logs writes for ~12 hours before this fix.
        runInBackground(c, refreshStatusBoard());
        runInBackground(c, maybeWarm());
        runInBackground(c, maybePrune());
      } catch (err) {
        clearInterval(heartbeat);
        const error = err as Error;
        const upstreamStatus = err instanceof ProviderError ? err.status : 500;
        const clientStatus = statusForClient(upstreamStatus);
        const usage = ensureUsage(meta, messages);
        appendLog(c, {
          timestamp: Date.now(),
          method: "POST",
          endpoint: "/v1/chat/completions",
          // Log the upstream status (real failure mode) so the admin
          // dashboard reflects what actually went wrong, not the
          // remapped client-facing status.
          status: upstreamStatus,
          duration: Date.now() - startTime,
          model,
          // Record which provider was routed to, even on failure, so
          // the admin dashboard can tell a provider error from a routing
          // miss. Success paths set `via` too — consistent attribution.
          via: provider.id,
          error: error.message,
          errorType: "stream_error",
          discordUserId: auth.discordUserId,
          discordUsername: auth.discordUsername,
          // Record tokens even on abort/error: a stop-mid-stream lands
          // here with `via` set, so it counts toward RPM/RPD — without
          // this it'd cost 0 TPD and stop-spam would be free tokens.
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          // accountId / accountLabel may have been set before the error
          // (provider picked an account, then upstream returned 502).
          // Keep them so the admin dashboard can see which account failed.
          accountId: meta.accountId,
          accountLabel: meta.accountLabel,
        });
        runInBackground(c, refreshStatusBoard());
        runInBackground(c, maybeWarm());
        runInBackground(c, maybePrune());
        // Emit a final error event in OpenAI format then close.
        await s.write(
          `data: ${JSON.stringify(maskedError(clientStatus))}\n\n`,
        );
        await s.write("data: [DONE]\n\n");
      }
    });
  }

  // Non-streaming branch.
  try {
    const response = await provider.chat(req, meta);
    appendLog(c, {
      timestamp: Date.now(),
      method: "POST",
      endpoint: "/v1/chat/completions",
      status: 200,
      duration: Date.now() - startTime,
      model,
      messageCount: messages.length,
      via: provider.id,
      discordUserId: auth.discordUserId,
      discordUsername: auth.discordUsername,
      promptTokens: meta.usage?.prompt_tokens,
      completionTokens: meta.usage?.completion_tokens,
      totalTokens: meta.usage?.total_tokens,
      accountId: meta.accountId,
      accountLabel: meta.accountLabel,
    });
    runInBackground(c, refreshStatusBoard());
    runInBackground(c, maybeWarm());
    runInBackground(c, maybePrune());
    return c.json(response);
  } catch (err) {
    const error = err as Error;
    const upstreamStatus = err instanceof ProviderError ? err.status : 500;
    const clientStatus = statusForClient(upstreamStatus);
    const usage = ensureUsage(meta, messages);
    appendLog(c, {
      timestamp: Date.now(),
      method: "POST",
      endpoint: "/v1/chat/completions",
      status: upstreamStatus,
      duration: Date.now() - startTime,
      model,
      // Attribute failed requests to the provider that owned them so the
      // admin dashboard's `via` column matches success rows. Without
      // this, every error appears as via=null even though the request
      // did pick a provider.
      via: provider.id,
      error: error.message,
      errorType: "provider_error",
      discordUserId: auth.discordUserId,
      discordUsername: auth.discordUsername,
      // Tokens on the error path too, so a failed/aborted non-stream
      // request still counts toward TPD (it has `via` set → counted).
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      accountId: meta.accountId,
      accountLabel: meta.accountLabel,
    });
    runInBackground(c, refreshStatusBoard());
    runInBackground(c, maybeWarm());
    runInBackground(c, maybePrune());
    return c.json(maskedError(clientStatus), clientStatus as 400);
  }
});

export default chat;
