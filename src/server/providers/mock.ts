/**
 * Mock provider. Returns canned responses. Useful for:
 *   - End-to-end testing the Hono server without any real backend.
 *   - Frontend development against the dashboard.
 *   - Smoke-testing streaming infrastructure.
 *
 * Model prefix: 'mock/'. Examples:
 *   mock/echo  -> echoes the user's last message
 *   mock/lorem -> returns lorem ipsum
 *
 * Always configured (no API keys needed).
 */

import { estimateTokens } from "../lib/token-estimate.js";
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelInfo,
  ProviderMeta,
} from "./types.js";

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

function lastUserMessage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === "user") return req.messages[i].content;
  }
  return "";
}

function pickResponse(req: ChatRequest): string {
  const model = req.model.replace(/^mock\//, "");
  if (model === "echo") return lastUserMessage(req);
  return LOREM;
}

function makeId(): string {
  return `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const mockProvider: ChatProvider = {
  id: "mock",

  isConfigured() {
    return true;
  },

  async models(): Promise<ModelInfo[]> {
    const now = Math.floor(Date.now() / 1000);
    return [
      { id: "mock/echo", object: "model", created: now, owned_by: "mock" },
      { id: "mock/lorem", object: "model", created: now, owned_by: "mock" },
    ];
  },

  async chat(req: ChatRequest, meta?: ProviderMeta): Promise<ChatResponse> {
    const text = pickResponse(req);
    const promptTokens = req.messages.reduce(
      (n, m) => n + estimateTokens(m.content),
      0,
    );
    const completionTokens = estimateTokens(text);
    if (meta) {
      meta.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }
    return {
      id: makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  },

  async *stream(req: ChatRequest, meta?: ProviderMeta): AsyncIterable<ChatStreamChunk> {
    const text = pickResponse(req);
    const id = makeId();
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = req.messages.reduce(
      (n, m) => n + estimateTokens(m.content),
      0,
    );
    const completionTokens = estimateTokens(text);
    if (meta) {
      meta.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }

    // Yield word-by-word with a small delay to simulate a real LLM.
    const words = text.split(/(\s+)/);

    // First chunk: role announcement.
    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    };

    for (const w of words) {
      await new Promise((r) => setTimeout(r, 20));
      yield {
        id,
        object: "chat.completion.chunk",
        created,
        model: req.model,
        choices: [{ index: 0, delta: { content: w }, finish_reason: null }],
      };
    }

    // Final chunk: stop signal.
    yield {
      id,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  },
};
