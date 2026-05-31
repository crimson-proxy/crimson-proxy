/**
 * The generic contract every provider implements.
 *
 * Adding a new provider = create a file in src/server/providers/<name>.ts
 * that exports an object implementing ChatProvider, then register it in
 * src/server/providers/registry.ts. Nothing else changes.
 *
 * Request/response shapes match the OpenAI Chat Completions API so that
 * clients (Janitor AI, OpenCode, etc.) don't need to know which provider
 * is being used downstream.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  // Catch-all for provider-specific extras (tools, response_format, etc.).
  // Providers may pass these through to their upstream verbatim.
  [k: string]: unknown;
};

export type ChatChoice = {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
};

export type ChatResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

/**
 * Streaming chunk shape (matches OpenAI's SSE deltas). Providers yield these
 * one at a time; the chat route formats them as `data: {...}\n\n` lines.
 */
export type ChatStreamChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: ChatChoice["finish_reason"];
  }>;
};

export type ModelInfo = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

/**
 * Out-parameter the chat route passes to provider methods so the provider
 * can hand back per-request bookkeeping (token usage, which upstream
 * account was used) without changing the OpenAI-shaped response.
 *
 * Why an out-param instead of a return value: `chat()` returns the
 * OpenAI ChatResponse verbatim to the client, and `stream()` is an async
 * iterable — neither shape has anywhere to attach internal metadata
 * cleanly. The provider mutates `meta` as it runs; the route reads it
 * after the call (non-streaming) or after the iterable finishes
 * (streaming). All fields are optional because providers that don't
 * support a metric (e.g. mock has no real accounts) simply don't set it.
 */
export type ProviderMeta = {
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /**
   * Numeric id of the upstream account used for this request, when the
   * provider has a multi-account pool. The provider id lives in the
   * `via` column of request_logs, so account_id is unambiguous in
   * context.
   */
  accountId?: number;
  /** Human-readable label of the upstream account, for log display. */
  accountLabel?: string;
};

/**
 * A provider knows how to:
 *   - report its identifier and the models it offers
 *   - run a non-streaming chat completion
 *   - run a streaming chat completion (async generator of SSE chunks)
 *   - tell whether it's currently configured (e.g. has its API key set)
 *
 * Both `chat()` and `stream()` accept an optional `meta` out-param that
 * the provider populates with token usage and account info. The chat
 * route reads it after the call to attach those fields to request_logs.
 */
export interface ChatProvider {
  /** Stable identifier used in model prefixes and registry lookup. */
  readonly id: string;

  /**
   * True if the provider has everything it needs to serve requests
   * (API keys, credentials, etc.). False = registered but unusable.
   * The registry filters these out at routing time.
   */
  isConfigured(): boolean;

  /** Static or dynamically fetched list of models this provider serves. */
  models(): Promise<ModelInfo[]>;

  /** Non-streaming chat completion. */
  chat(req: ChatRequest, meta?: ProviderMeta): Promise<ChatResponse>;

  /** Streaming chat completion (yields OpenAI-format SSE chunks). */
  stream(req: ChatRequest, meta?: ProviderMeta): AsyncIterable<ChatStreamChunk>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly status: number = 500,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
