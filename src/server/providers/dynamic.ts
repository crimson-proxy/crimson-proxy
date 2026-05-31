/**
 * Generic OpenAI-compatible provider engine.
 *
 * One factory that turns a DB `providers` row (kind='openai') into a
 * ChatProvider. This replaces the old hand-written openrouter.ts and
 * vixai.ts — both were the exact same "strip prefix, swap bearer, forward
 * verbatim, parse OpenAI SSE" passthrough, just with a different BASE_URL
 * and env var. Now the BASE_URL and key live in the DB and admins add
 * providers from the dashboard; this file is the only code that runs them.
 *
 * Why no prefix-stripping here (the old files did `model.replace(/^vx\//,
 * "")`): the registry now resolves the user's model string to a concrete
 * upstream id BEFORE calling the provider (display-name masking happens
 * there, against the provider_models table). So `req.model` is already the
 * exact id the upstream expects — we forward it verbatim. Keeps this
 * engine dumb and the routing/masking logic in one place (registry.ts).
 *
 * The public model catalog is injected by the registry too: it builds
 * each provider from the cfg + that provider's enabled provider_models
 * rows, so `models()` just echoes what the registry already resolved
 * (masked display names, prefixed). Admin "refresh models" uses the
 * separate fetchUpstreamModels() to discover the raw upstream list.
 *
 * Failure modes worth knowing (same as the old openrouter.ts notes):
 *   - 401: api_key missing/wrong.
 *   - 402: out of credits (pay-per-use upstreams like OpenRouter).
 *   - 429: rate-limited by the upstream itself.
 *   - 5xx / timeout: upstream down, or (VixAI's HF Space) asleep and
 *     cold-starting — the chat route already sends SSE heartbeats so
 *     clients don't time out during the cold start.
 */

import { estimateTokens } from "../lib/token-estimate.js";
import {
  ProviderError,
  type ChatProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type ModelInfo,
  type ProviderMeta,
} from "./types.js";

/**
 * The subset of a `providers` DB row this engine needs. The registry
 * loads the row, the admin layer writes it; this engine only reads.
 */
export type ProviderConfig = {
  /** Stable id — request_logs.via + the limits/tiers key. Never changes. */
  id: string;
  /** User-facing routing prefix (e.g. 'vx'). Display only; not sent upstream. */
  prefix: string;
  /** OpenAI-compatible base, ending at …/v1 (no trailing slash needed). */
  baseUrl: string;
  /** Upstream bearer key. Never leaves the server. */
  apiKey: string;
  /** Optional static headers merged into every upstream call. */
  extraHeaders?: Record<string, string> | null;
};

/** A model the registry has already resolved from provider_models. */
export type ResolvedModel = {
  /** Real id forwarded to the upstream. */
  upstreamId: string;
  /** Bare name shown to users after the prefix (masked or = upstreamId). */
  displayName: string;
  /** Vendor label for the landing page group header. */
  ownedBy?: string | null;
};

const MODELS_TIMEOUT_MS = 5000;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function authHeaders(cfg: ProviderConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...(cfg.extraHeaders ?? {}),
  };
}

/**
 * Discover the raw upstream model list via GET {base}/models. Used by the
 * admin add / refresh-models flow to populate provider_models — NOT on the
 * request hot path. Throws ProviderError on any failure so the admin sees
 * exactly why a provider couldn't be added (bad URL, bad key, asleep, …)
 * instead of a silent empty list.
 */
export async function fetchUpstreamModels(
  cfg: ProviderConfig,
): Promise<Array<{ id: string; owned_by?: string }>> {
  let res: Response;
  try {
    res = await fetch(`${trimBase(cfg.baseUrl)}/models`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(
      `Could not reach ${cfg.baseUrl}/models: ${(err as Error).message}`,
      cfg.id,
      502,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      `Upstream /models returned ${res.status}: ${text.slice(0, 300)}`,
      cfg.id,
      res.status,
      res.status,
    );
  }
  const data = (await res.json().catch(() => ({}))) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };
  const list = (data.data ?? [])
    .filter((m): m is { id: string; owned_by?: string } => Boolean(m.id))
    .map((m) => ({ id: m.id, owned_by: m.owned_by }));
  if (list.length === 0) {
    throw new ProviderError(
      "Upstream /models returned no models (endpoint reachable but empty).",
      cfg.id,
      502,
    );
  }
  return list;
}

/** Compute a usage estimate from char counts (fallback when upstream omits it). */
function estimateUsage(req: ChatRequest, output: string) {
  const prompt = req.messages.reduce(
    (n, m) => n + estimateTokens(m.content),
    0,
  );
  const completion = estimateTokens(output);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/**
 * Build a ChatProvider from a DB provider row + its (already resolved,
 * enabled) model rows. `models` is what the registry exposes publicly:
 * the prefix is applied here, display names are whatever the admin set.
 */
export function makeOpenAIProvider(
  cfg: ProviderConfig,
  models: ResolvedModel[],
): ChatProvider {
  const base = trimBase(cfg.baseUrl);

  return {
    id: cfg.id,

    isConfigured() {
      return Boolean(cfg.baseUrl && cfg.apiKey);
    },

    async models(): Promise<ModelInfo[]> {
      const now = Math.floor(Date.now() / 1000);
      return models.map((m) => ({
        // Prefixed so the id round-trips: a client echoes 'vx/foo' back
        // and the registry routes it here again. The registry strips the
        // prefix + un-masks the display name before chat()/stream().
        id: `${cfg.prefix}/${m.displayName}`,
        object: "model" as const,
        created: now,
        // Vendor label for the public landing-page grouping. Falls back
        // to "auto" — NEVER cfg.id — so an internal provider id can't
        // surface as a user-facing group (AI.md rule 6). Matches the old
        // vixai.ts behaviour for ids with no derivable vendor.
        owned_by: m.ownedBy || "auto",
      }));
    },

    async chat(req: ChatRequest, meta?: ProviderMeta): Promise<ChatResponse> {
      if (!this.isConfigured()) {
        throw new ProviderError(
          `Provider '${cfg.id}' is not configured (missing base URL or key).`,
          cfg.id,
          503,
        );
      }

      // req.model is already the upstream id (registry resolved it).
      const body = { ...req, stream: false };

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(cfg),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError(
          `${cfg.id} error: ${text.slice(0, 500)}`,
          cfg.id,
          res.status,
          res.status,
        );
      }

      const parsed = (await res.json()) as ChatResponse;
      if (meta && parsed.usage) meta.usage = parsed.usage;
      return parsed;
    },

    async *stream(
      req: ChatRequest,
      meta?: ProviderMeta,
    ): AsyncIterable<ChatStreamChunk> {
      if (!this.isConfigured()) {
        throw new ProviderError(
          `Provider '${cfg.id}' is not configured (missing base URL or key).`,
          cfg.id,
          503,
        );
      }

      // include_usage asks the upstream to append a final non-content
      // chunk carrying the real `usage`. OpenAI-format, so clients that
      // ignore unknown fields keep working; if the upstream drops it we
      // fall back to a char-count estimate below.
      const body = {
        ...req,
        stream: true,
        stream_options: { include_usage: true },
      };

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: authHeaders(cfg),
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "(no body)";
        throw new ProviderError(
          `${cfg.id} stream error: ${text.slice(0, 500)}`,
          cfg.id,
          res.status,
          res.status,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let receivedUsage = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by blank lines. Process complete
          // frames; leave any partial frame for the next read.
          let sepIdx: number;
          while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);

            for (const line of frame.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") {
                if (meta && !receivedUsage) {
                  meta.usage = estimateUsage(req, accumulated);
                }
                return;
              }
              try {
                const chunk = JSON.parse(payload) as ChatStreamChunk & {
                  usage?: ProviderMeta["usage"];
                };
                // The usage chunk has no content; pull it before
                // forwarding so we don't hand the client a content-less
                // chunk.
                if (chunk.usage && meta) {
                  meta.usage = chunk.usage;
                  receivedUsage = true;
                }
                accumulated += chunk.choices?.[0]?.delta?.content ?? "";
                yield chunk;
              } catch {
                // Ignore malformed chunks / keep-alives.
              }
            }
          }
        }
        // Stream closed without [DONE]; still finalize a usage estimate.
        if (meta && !receivedUsage) {
          meta.usage = estimateUsage(req, accumulated);
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
