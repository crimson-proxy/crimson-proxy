import { Hono } from "hono";
import { verifyAdminToken } from "./admin.js";
import { clearLogs, getRecentLogs } from "../lib/logs.js";

const logs = new Hono();

/**
 * Admin-only middleware for log access. Requires the same Bearer token
 * used by /api/admin/* routes.
 */
async function requireAdmin(
  c: Parameters<Parameters<typeof logs.use>[1]>[0],
  next: () => Promise<void>,
): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return c.json({ error: "Bad Authorization header" }, 401);
  }
  const ok = await verifyAdminToken(match[1].trim());
  if (!ok) {
    return c.json({ error: "Invalid or expired admin token" }, 401);
  }
  return next();
}

logs.get("/api/logs", requireAdmin, async (c) => {
  const { logs, total, source } = await getRecentLogs(100);
  return c.json({ logs, total, source });
});

logs.delete("/api/logs", requireAdmin, async (c) => {
  const { source } = await clearLogs();
  return c.json({ success: true, source });
});

export default logs;
