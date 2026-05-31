import { Hono } from "hono";
import { allProviders } from "../providers/registry.js";

const health = new Hono();

health.get("/health", async (c) => {
  const providers = (await allProviders()).map((p) => ({
    id: p.id,
    configured: p.isConfigured(),
  }));

  const anyConfigured = providers.some((p) => p.configured);

  return c.json({
    status: anyConfigured ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "3.0.0-hono",
    providers,
  });
});

export default health;
