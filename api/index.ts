/**
 * Vercel serverless entry point.
 *
 * Vercel auto-detects files under api/ as serverless functions. We export
 * a standard Node.js (req, res) handler that manually converts the Node
 * IncomingMessage into a Web Standard Request, passes it through Hono,
 * and writes the Response back.
 *
 * Why not use hono/vercel's handle()? As of Hono 4.12 + Vercel's Node
 * runtime (May 2026), handle() assumes the incoming object is already a
 * Web Standard Request, but Vercel's Node runtime passes a Node
 * IncomingMessage. This causes "this.raw.headers.get is not a function".
 * The manual conversion below works reliably on both runtimes.
 *
 * Same routes as the Node server: no business logic lives here. If you add
 * routes, edit src/server/app.ts and they'll work on both runtimes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import app from "../src/server/app.js";

export const config = {
  // Use the Node runtime so we keep access to node:crypto for RS256 JWT
  // signing and SHA-256 key hashing.
  runtime: "nodejs",
  // 5-minute hard ceiling. Vercel's Pro tier cap. Needed for the
  // admin "Test models" endpoint, which sends a tiny chat completion
  // to every model on a provider with a 15s per-probe deadline; on a
  // provider with hundreds of models (cre/ peaks at ~400) the worst-
  // case wall-clock at concurrency=20 sits at a few minutes. Other
  // routes finish in well under a second, so the higher ceiling here
  // is harmless for them.
  maxDuration: 300,
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Build a Web Standard Request from the Node IncomingMessage.
  const protocol = req.headers["x-forwarded-proto"] ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);

  // ─── /v1/* moved to Cloudflare ──────────────────────────────────────
  // Chat completions + model list are CF-only now. Returning 410 Gone
  // with a moved-to URL so OpenAI-compatible clients (JanitorAI etc.)
  // surface a clear "update your endpoint" error rather than silently
  // failing. Dashboard / auth / admin routes still serve from here.
  if (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/models" || url.pathname.startsWith("/v1/")) {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "This endpoint has moved. Update your base URL to https://app.crimsons-proxy.workers.dev/v1 — the Vercel mirror no longer serves the OpenAI-compatible API.",
          type: "endpoint_moved",
          code: 410,
          new_base_url: "https://app.crimsons-proxy.workers.dev/v1",
        },
      }),
    );
    return;
  }

  // Read the body for non-GET/HEAD requests.
  let body: Buffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    body = Buffer.concat(chunks);
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const webRequest = new Request(url.toString(), {
    method: req.method ?? "GET",
    headers,
    body: body ? new Uint8Array(body) : null,
    duplex: body ? "half" : undefined,
  } as RequestInit);

  // Let Hono handle it.
  const webResponse = await app.fetch(webRequest);

  // Write the Web Standard Response back to the Node ServerResponse.
  res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));

  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  res.end();
}
