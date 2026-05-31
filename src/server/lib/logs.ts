/**
 * Request log buffer.
 *
 * Two backends:
 * - In-memory ring buffer (used for local dev or any future long-running
 *   Node host — not currently deployed in production).
 * - Postgres (used in production; survives restarts and cold starts).
 *
 * Run `npm run migrate` to create/update the schema. The request_logs
 * table includes discord_user_id and discord_username columns for
 * correlating requests to Discord users via the API key auth layer.
 *
 * ─── Why appendLog takes the Hono Context ─────────────────────────────
 * The INSERT is fire-and-forget from the caller's perspective (the chat
 * response should not block on writing the audit row). BUT on serverless
 * runtimes (CF Workers, Vercel functions) the invocation terminates with
 * the response — any unfinished I/O is dropped, so the row never commits.
 * Routing the insert through `runInBackground(c, ...)` registers it with
 * the runtime's waitUntil so the row commits even after the response
 * goes out. On long-running Node, runInBackground is a no-op beyond the
 * .catch (the event loop keeps the promise alive on its own).
 */

import type { Context } from "hono";
import { runInBackground } from "./background.js";
import { getDb, hasDb } from "./db.js";

export type LogEntry = {
  timestamp: number;
  method: string;
  endpoint: string;
  status: number;
  duration: number;
  model?: string;
  messageCount?: number;
  via?: string;
  error?: string;
  errorType?: string;
  discordUserId?: string | null;
  discordUsername?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  /** Numeric id of the upstream account, when the provider runs a multi-account pool. */
  accountId?: number | null;
  /** Human-readable label of the upstream account. */
  accountLabel?: string | null;
};

const MAX_IN_MEMORY = 100;
const inMemory: LogEntry[] = [];

export function appendLog(c: Context, entry: LogEntry): void {
  if (!hasDb()) {
    inMemory.push(entry);
    if (inMemory.length > MAX_IN_MEMORY) inMemory.shift();
    return;
  }

  const sql = getDb();
  const insert = sql`
    insert into request_logs (
      created_at, method, endpoint, status, duration_ms, model,
      message_count, via, error, error_type,
      discord_user_id, discord_username,
      prompt_tokens, completion_tokens, total_tokens,
      account_id, account_label
    ) values (
      ${new Date(entry.timestamp).toISOString()},
      ${entry.method},
      ${entry.endpoint},
      ${entry.status},
      ${entry.duration},
      ${entry.model ?? null},
      ${entry.messageCount ?? null},
      ${entry.via ?? null},
      ${entry.error ?? null},
      ${entry.errorType ?? null},
      ${entry.discordUserId ?? null},
      ${entry.discordUsername ?? null},
      ${entry.promptTokens ?? null},
      ${entry.completionTokens ?? null},
      ${entry.totalTokens ?? null},
      ${entry.accountId ?? null},
      ${entry.accountLabel ?? null}
    )
  `;
  runInBackground(c, insert as unknown as Promise<unknown>);
}

type LogRow = {
  created_at: string;
  method: string;
  endpoint: string;
  status: number;
  duration_ms: number;
  model: string | null;
  message_count: number | null;
  via: string | null;
  error: string | null;
  error_type: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  account_id: number | null;
  account_label: string | null;
};

function rowToEntry(row: LogRow): LogEntry {
  return {
    timestamp: new Date(row.created_at).getTime(),
    method: row.method,
    endpoint: row.endpoint,
    status: row.status,
    duration: row.duration_ms,
    model: row.model ?? undefined,
    messageCount: row.message_count ?? undefined,
    via: row.via ?? undefined,
    error: row.error ?? undefined,
    errorType: row.error_type ?? undefined,
    discordUserId: row.discord_user_id ?? undefined,
    discordUsername: row.discord_username ?? undefined,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    totalTokens: row.total_tokens ?? undefined,
    accountId: row.account_id ?? undefined,
    accountLabel: row.account_label ?? undefined,
  };
}

export async function getRecentLogs(limit = 100): Promise<{
  logs: LogEntry[];
  total: number;
  source: "memory" | "postgres";
}> {
  if (hasDb()) {
    const sql = getDb();
    try {
      const rows = await sql<LogRow[]>`
        select created_at, method, endpoint, status, duration_ms, model,
               message_count, via, error, error_type,
               discord_user_id, discord_username,
               prompt_tokens, completion_tokens, total_tokens,
               account_id, account_label
        from request_logs
        order by created_at desc
        limit ${limit}
      `;
      const [{ count }] = await sql<{ count: number }[]>`
        select count(*)::int as count from request_logs
      `;
      return {
        logs: rows.map(rowToEntry),
        total: Number(count),
        source: "postgres",
      };
    } catch (err) {
      console.error("[logs] select failed:", (err as Error).message);
      return { logs: [], total: 0, source: "postgres" };
    }
  }

  return {
    logs: inMemory.slice(-limit).reverse(),
    total: inMemory.length,
    source: "memory",
  };
}

export async function clearLogs(): Promise<{ source: "memory" | "postgres" }> {
  if (hasDb()) {
    const sql = getDb();
    try {
      await sql`delete from request_logs`;
    } catch (err) {
      console.error("[logs] delete failed:", (err as Error).message);
    }
    return { source: "postgres" };
  }

  inMemory.length = 0;
  return { source: "memory" };
}
