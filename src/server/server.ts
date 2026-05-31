/**
 * Node entry point. Used for local dev today; left in place so a
 * long-running Node host stays an option later. Production runs on
 * Vercel via api/index.ts.
 */

import "dotenv/config"; // Load .env before anything reads process.env.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";

import app from "./app.js";
import { config } from "./lib/config.js";

// Where the built Vite dashboard lives. We resolve from the current working
// directory (the project root when you run `npm run dev:server`) rather than
// from this file's location, which jumps around depending on whether tsx is
// running the source or node is running compiled output.
const distPath = path.resolve(process.cwd(), "dist");

const root = new Hono();
root.route("/", app);

root.use(
  "/*",
  serveStatic({
    root: path.relative(process.cwd(), distPath),
  }),
);

// SPA fallback so client-side routing works for any unmatched GET.
root.get("*", async (c) => {
  try {
    const file = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(distPath, "index.html"), "utf-8"),
    );
    return c.html(file);
  } catch {
    return c.text("Dashboard build not found. Run `npm run build` first.", 404);
  }
});

const port = config.port;

serve({ fetch: root.fetch, port }, (info) => {
  console.log(`
╔═══════════════════════════════════════════════╗
║  🐱 Crimson's Proxy Server (Hono) 🐱         ║
╠═══════════════════════════════════════════════╣
║  🌐 Open:    http://localhost:${info.port}           ║
║  ❤️  Health:  http://localhost:${info.port}/health    ║
║  📊 Logs:    http://localhost:${info.port}/api/logs  ║
╚═══════════════════════════════════════════════╝

✨ Server is running. Open the URL above in your browser.
  `);
});
