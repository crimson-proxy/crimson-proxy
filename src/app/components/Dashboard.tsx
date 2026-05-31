import { useState, useEffect, useMemo } from "react";
import {
  Key,
  Cat,
  Sparkles,
  Activity,
  CheckCircle,
  Clock,
  LogOut,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Coins,
} from "lucide-react";
import { toast } from "sonner";
import { groupForUi, type Model } from "../lib/grouping";

type SessionUser = {
  id: string;
  username: string;
  avatar: string | null;
};

type ApiKey = {
  id: number;
  keyPreview: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  notes: string | null;
};

type HealthData = {
  status: string;
  providers: { id: string; configured: boolean }[];
};

interface DashboardProps {
  user: SessionUser;
  onLogout: () => void;
  isAdmin?: boolean;
}

export function Dashboard({ user, onLogout, isAdmin }: DashboardProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [statusData, setStatusData] = useState<any>(null);

  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const token = localStorage.getItem("crimson-session");

  useEffect(() => {
    const headers: HeadersInit = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    Promise.all([
      fetch("/api/keys", { headers })
        .then((r) => r.json())
        .then((d: { keys?: ApiKey[] }) => setKeys(d.keys ?? []))
        .catch(() => {}),
      fetch("/api/models")
        .then((r) => r.json())
        .then((d: { models: Model[]; total: number }) => {
          setModels(d.models);
        })
        .catch(() => {}),
      fetch("/health")
        .then((r) => r.json())
        .then((d: HealthData) => setHealth(d))
        .catch(() => {}),
      fetch("/api/user/status", { headers })
        .then((r) => r.json())
        .then((d: any) => setStatusData(d))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
        // Subtle toast so the user gets feedback even if they didn't see
        // the inline check icon (e.g. fast click followed by tab away).
        toast.success("Copied to clipboard~", { duration: 1500 });
      },
      () => {
        toast.error("Nya... couldn't copy that", { description: "Your browser blocked clipboard access." });
      },
    );
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);

  // Same prefix-grouping rule LandingPage uses, sourced from data we
  // mint (the routing prefix on each model id) instead of the
  // upstream-supplied `owned_by` — so no upstream-vendor name like
  // "fastino" can leak into the section headers.
  //
  // Dashboard intentionally only renders the per-prefix sections —
  // the Premium/Claude shortcut lives on the public landing page
  // where new visitors benefit from it; logged-in dashboard users
  // already know what they're looking for.
  const { byPrefix } = useMemo(() => groupForUi(models), [models]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5">
        <div className="absolute top-10 left-10 text-6xl">🐱</div>
        <div className="absolute top-20 right-20 text-5xl">🌸</div>
        <div className="absolute bottom-20 left-20 text-5xl">🌺</div>
        <div className="absolute bottom-10 right-10 text-6xl">🏵️</div>
      </div>

      <div className="max-w-5xl mx-auto relative z-10">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Cat className="w-8 h-8 text-primary" />
            <h1 className="text-primary text-2xl font-bold">Dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {user.avatar ? (
                <img
                  src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=32`}
                  alt=""
                  className="w-8 h-8 rounded-full"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs text-primary">
                  {user.username.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="text-sm text-card-foreground font-medium">
                {user.username}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="/status"
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
              >
                <Activity className="w-4 h-4" />
                Status
              </a>
              {isAdmin && (
                <a
                  href="/admin"
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  <Cat className="w-4 h-4" />
                  Admin
                </a>
              )}
              <button
                onClick={onLogout}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-destructive transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </header>

        {/* Status bar */}
        <div className="grid sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-card border border-border rounded-xl p-4 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              {health?.status === "healthy" ? (
                <CheckCircle className="w-4 h-4 text-green-500" />
              ) : (
                <Activity className="w-4 h-4 text-red-500" />
              )}
              <span className="text-xs text-muted-foreground">Status</span>
            </div>
            <p className="text-lg font-bold text-card-foreground capitalize">
              {health?.status ?? "Unknown"}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Key className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">Active Keys</span>
            </div>
            <p className="text-lg font-bold text-card-foreground">
              {activeKeys.length}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">Models</span>
            </div>
            <p className="text-lg font-bold text-card-foreground">{models.length}</p>

          </div>
        </div>

        {statusData && statusData.isBanned && (
          <div className="bg-destructive/10 border-2 border-destructive/50 rounded-2xl p-6 mb-8 text-center animate-fade-up">
            <h2 className="text-xl font-bold text-destructive mb-2">
              {statusData.activeBan?.expires_at ? "⏳ Account on Break" : "❌ Account Banned"}
            </h2>
            <p className="text-sm text-foreground/80 mb-2">
              {statusData.activeBan?.expires_at 
                ? `You are currently on a timeout until ${new Date(statusData.activeBan.expires_at).toLocaleString()}.`
                : "Your account has been permanently banned from using the proxy."
              }
            </p>
            <div className="inline-block bg-input-background px-4 py-2 rounded border border-border">
              <span className="text-xs text-muted-foreground mr-2">Reason:</span>
              <span className="text-sm font-medium">{statusData.activeBan?.reason || "No reason given"}</span>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {/* API Keys */}
          <div className="bg-card border-2 border-primary rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-primary" />
                <h2 className="text-primary font-semibold">Your API Keys</h2>
              </div>
              <span className="text-sm text-muted-foreground">
                {activeKeys.length} active
              </span>
            </div>

            {keys.length === 0 ? (
              <div className="text-center py-8">
                <Key className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">
                  No API keys yet. Use{" "}
                  <code className="text-primary">/get-api-key</code> in Discord
                  to create one.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {activeKeys.map((key) => (
                  <div
                    key={key.id}
                    className="bg-input-background border border-border rounded-lg p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-mono text-card-foreground">
                        {key.keyPreview ?? `Key #${key.id}`}
                      </span>
                      <span className="text-xs text-green-500">Active</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      <p>Created: {formatDate(key.createdAt)}</p>
                      <p>
                        Last used:{" "}
                        {key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}
                      </p>
                    </div>
                  </div>
                ))}
                {revokedKeys.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-muted-foreground cursor-pointer">
                      {revokedKeys.length} revoked key(s)
                    </summary>
                    <div className="space-y-2 mt-2">
                      {revokedKeys.map((key) => (
                        <div
                          key={key.id}
                          className="bg-input-background border border-border rounded-lg p-3 opacity-50"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-mono text-card-foreground">
                              Key #{key.id}
                            </span>
                            <span className="text-xs text-destructive">
                              Revoked
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* Server info */}
          <div className="bg-card border-2 border-primary rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-5 h-5 text-primary" />
              <h2 className="text-primary font-semibold">Proxy Info</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="bg-accent/20 border border-primary/30 rounded-lg p-3">
                <p className="text-primary mb-1">🔗 Endpoint</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-card-foreground flex-1 break-all">
                    {window.location.origin}/v1/chat/completions
                  </code>
                  <button
                    onClick={() =>
                      copyText(
                        `${window.location.origin}/v1/chat/completions`,
                        "endpoint",
                      )
                    }
                    className="p-1 rounded hover:bg-accent transition-colors"
                  >
                    {copiedId === "endpoint" ? (
                      <Check className="w-3 h-3 text-green-500" />
                    ) : (
                      <Copy className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>
                </div>
              </div>


              <div className="bg-accent/20 border border-primary/30 rounded-lg p-3">
                <p className="text-primary mb-1">🔒 Privacy</p>
                <span className="text-card-foreground">
                  We do not store, monitor, or log any of your prompts.
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Models — prefix-grouped per provider (PN/VX/TM…), same
            sectioning the Discord board and /status page use. No
            Premium shortcut on Dashboard by design — logged-in users
            already know what they're looking for; the Claude
            shortcut lives on the public landing page where new
            visitors benefit from it. */}
        <div className="bg-card border-2 border-primary rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <h2 className="text-primary font-semibold">Available Models</h2>
            </div>
            <span className="text-sm text-muted-foreground">
              {models.length} models
            </span>
          </div>

          {models.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No models available.
            </p>
          ) : (
            <div className="space-y-5">
              {byPrefix.map(([prefix, providerModels]) => (
                <DashboardModelSection
                  key={prefix}
                  label={prefix.toUpperCase()}
                  models={providerModels}
                  copiedId={copiedId}
                  onCopy={(m) => copyText(m.id, m.id)}
                />
              ))}
            </div>
          )}
        </div>

        {statusData?.history?.length > 0 && (
          <div className="bg-card border-2 border-border rounded-2xl p-6 mt-8 mb-8 animate-fade-up" style={{ animationDelay: "200ms" }}>
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold text-card-foreground">Account History</h2>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-muted/30 border-b border-border">
                    <th className="p-3 text-xs font-semibold text-muted-foreground">Type</th>
                    <th className="p-3 text-xs font-semibold text-muted-foreground">Date</th>
                    <th className="p-3 text-xs font-semibold text-muted-foreground">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {statusData.history.map((h: any, i: number) => (
                    <tr key={i} className="hover:bg-muted/10">
                      <td className="p-3 text-sm">
                        {h.expires_at ? (
                          <span className="text-yellow-500 flex items-center gap-1"><Clock className="w-3 h-3"/> Timeout</span>
                        ) : (
                          <span className="text-destructive flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> Ban</span>
                        )}
                      </td>
                      <td className="p-3 text-sm text-muted-foreground">{formatDate(h.banned_at)}</td>
                      <td className="p-3 text-sm">{h.reason || "No reason given"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <RequestHistory />

        <footer className="text-center mt-12 text-muted-foreground text-sm">
          <p>🐱 Made with love in a crimson cottage 🌸</p>
        </footer>
      </div>
    </div>
  );
}

// ─── Dashboard models section ───────────────────────────────────────────

interface DashboardModelSectionProps {
  label: string;
  models: Model[];
  copiedId: string | null;
  onCopy: (m: Model) => void;
}

/**
 * One per-prefix block in the Dashboard's "Available Models" list.
 *
 * Smaller, denser styling than the LandingPage equivalent — this is
 * the dashboard view, not the landing page, so we trade glow for
 * scan-density. Click anywhere on a card copies the model id.
 */
function DashboardModelSection({
  label,
  models,
  copiedId,
  onCopy,
}: DashboardModelSectionProps) {
  return (
    <section>
      {/* Prefix header (PN/VX/TM…) — uppercase + monospace to match
          the section header on the /status page so the two surfaces
          feel like the same product. */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-primary font-mono tracking-wider">
          {label}
        </h3>
        <span className="text-[10px] text-muted-foreground font-medium">
          {models.length} model{models.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {models.map((model) => (
          <div
            key={model.id}
            className="bg-input-background border border-border rounded-lg px-3 py-2 hover:border-primary/50 transition-colors group flex items-center justify-between"
          >
            <p className="text-sm text-card-foreground group-hover:text-primary transition-colors break-all">
              {model.name}
            </p>
            <button
              onClick={() => onCopy(model)}
              className="p-1 rounded hover:bg-accent transition-colors flex-shrink-0 ml-2"
              aria-label={`Copy ${model.name}`}
            >
              {copiedId === model.id ? (
                <Check className="w-3 h-3 text-green-500" />
              ) : (
                <Copy className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Request history section ────────────────────────────────────────────
//
// Self-contained component for the /dashboard "Your Recent Requests"
// block. Fetches GET /api/me/logs, owns its own pagination/filter state,
// and lazy-refreshes when the user changes filters.

type UserLog = {
  id: number;
  created_at: string;
  status: number;
  error_type: string | null;
  duration_ms: number;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
};

type LogSummary = {
  requests: number;
  successful: number;
  errors: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
};

type Range = "24h" | "7d" | "30d" | "all";

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RequestHistory() {
  const token = localStorage.getItem("crimson-session");
  const [logs, setLogs] = useState<UserLog[]>([]);
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const [range, setRange] = useState<Range>("24h");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error">("all");
  const [modelFilter, setModelFilter] = useState("");
  const [page, setPage] = useState(1);
  const limit = 20;

  // Reset to page 1 whenever a filter changes; otherwise the user could
  // be stuck on page 5 of a result set that just shrank to one page.
  useEffect(() => {
    setPage(1);
  }, [range, statusFilter, modelFilter]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({
      range,
      status: statusFilter,
      page: String(page),
      limit: String(limit),
    });
    if (modelFilter) params.set("model", modelFilter);
    fetch(`/api/me/logs?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return;
        setLogs(d.logs ?? []);
        setSummary(d.summary ?? null);
        setModels(d.models ?? []);
        setTotalCount(d.totalCount ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [token, range, statusFilter, modelFilter, page]);

  if (!token) return null;

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  return (
    <div className="bg-card border-2 border-primary rounded-2xl p-6 mt-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-primary font-semibold">Your Recent Requests</h2>
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
          className="px-3 py-1.5 bg-input-background border-2 border-border rounded-lg text-xs focus:outline-none focus:border-primary"
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-input-background border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground">Requests</div>
          <div className="text-xl font-bold text-card-foreground mt-0.5">
            {summary ? summary.requests.toLocaleString() : "—"}
          </div>
        </div>
        <div className="bg-input-background border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Coins className="w-3 h-3" /> Tokens
          </div>
          <div
            className="text-xl font-bold text-yellow-600 dark:text-yellow-400 mt-0.5"
            title={
              summary
                ? `${summary.promptTokens.toLocaleString()} in · ${summary.completionTokens.toLocaleString()} out`
                : ""
            }
          >
            {summary ? fmtTokens(summary.totalTokens) : "—"}
          </div>
          {summary && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {fmtTokens(summary.promptTokens)} in · {fmtTokens(summary.completionTokens)} out
            </div>
          )}
        </div>
        <div className="bg-input-background border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground">Success rate</div>
          <div className="text-xl font-bold text-green-500 mt-0.5">
            {summary && summary.requests > 0 ? `${summary.successRate}%` : "—"}
          </div>
          {summary && summary.requests > 0 && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {summary.successful} ok · {summary.errors} err
            </div>
          )}
        </div>
        <div className="bg-input-background border border-border rounded-lg p-3">
          <div className="text-xs text-muted-foreground">Avg duration</div>
          <div className="text-xl font-bold text-card-foreground mt-0.5">
            {summary && summary.requests > 0 ? fmtDuration(summary.avgDurationMs) : "—"}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="px-3 py-1.5 bg-input-background border-2 border-border rounded-lg text-xs focus:outline-none focus:border-primary"
        >
          <option value="all">All statuses</option>
          <option value="success">Success only</option>
          <option value="error">Errors only</option>
        </select>
        <select
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="px-3 py-1.5 bg-input-background border-2 border-border rounded-lg text-xs focus:outline-none focus:border-primary min-w-[180px]"
        >
          <option value="">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left border-collapse text-sm">
          <thead className="bg-muted/30 border-b border-border">
            <tr>
              <th className="p-3 text-xs font-semibold text-muted-foreground">Time</th>
              <th className="p-3 text-xs font-semibold text-muted-foreground">Model</th>
              <th className="p-3 text-xs font-semibold text-muted-foreground text-right">Tokens</th>
              <th className="p-3 text-xs font-semibold text-muted-foreground text-right">Status</th>
              <th className="p-3 text-xs font-semibold text-muted-foreground text-right">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center p-8 text-muted-foreground">
                  Loading...
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center p-8 text-muted-foreground">
                  No requests in this range yet.
                </td>
              </tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id} className="hover:bg-muted/10">
                  <td className="p-3 text-muted-foreground whitespace-nowrap">
                    {new Date(l.created_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="p-3">
                    <code className="bg-input-background border border-border px-2 py-0.5 rounded text-xs">
                      {l.model || "—"}
                    </code>
                  </td>
                  <td
                    className="p-3 text-right text-yellow-600 dark:text-yellow-400 text-xs font-medium"
                    title={
                      l.total_tokens != null
                        ? `${Number(l.prompt_tokens || 0).toLocaleString()} in · ${Number(l.completion_tokens || 0).toLocaleString()} out`
                        : "no token data"
                    }
                  >
                    {l.total_tokens != null ? fmtTokens(l.total_tokens) : "—"}
                  </td>
                  <td className="p-3 text-right">
                    {l.status >= 400 ? (
                      <span className="text-destructive font-semibold text-xs">
                        {l.status}
                        {l.error_type ? ` · ${l.error_type}` : ""}
                      </span>
                    ) : (
                      <span className="text-green-500 font-semibold text-xs">{l.status}</span>
                    )}
                  </td>
                  <td className="p-3 text-right text-muted-foreground text-xs">
                    {fmtDuration(l.duration_ms)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalCount > limit && (
        <div className="flex items-center justify-between mt-3">
          <div className="text-xs text-muted-foreground">
            Page {page} of {totalPages} · {totalCount.toLocaleString()} total
          </div>
          <div className="flex gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
              className="p-1.5 border border-border rounded hover:bg-accent disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="p-1.5 border border-border rounded hover:bg-accent disabled:opacity-50"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
