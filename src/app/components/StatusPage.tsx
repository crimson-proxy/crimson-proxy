import { useEffect, useMemo, useState } from "react";
import { Activity, Cat, LogOut, LayoutDashboard, RefreshCw, Copy, Check } from "lucide-react";

/**
 * Visual model-health page at /status. Logged-in users only.
 *
 * Same data the Discord channel board renders, but as a real React
 * page with proper colored squares (not emoji), grouped by routing
 * prefix. Polls /api/status every 60 seconds; the squares are pure
 * CSS so the page stays cheap to redraw.
 */

type SessionUser = {
  id: string;
  username: string;
  avatar: string | null;
};

type Bar = {
  color: "green" | "yellow" | "red";
  status: number;
  durationMs: number;
  at: string;
};

type ModelStatus = {
  id: string;
  ownedBy: string;
  window: number;
  bars: Bar[];
  summary: {
    ok: number;
    slow: number;
    error: number;
    missing: number;
  };
};

type ProviderOwner = {
  prefix: string;
  owner: { id: string; username: string; avatar: string | null } | null;
};

type StatusResponse = {
  generatedAt: string;
  models: ModelStatus[];
  providers?: ProviderOwner[];
};

interface StatusPageProps {
  user: SessionUser;
  onLogout: () => void;
  isAdmin?: boolean;
}

const POLL_MS = 60_000;

export function StatusPage({ user, onLogout, isAdmin }: StatusPageProps) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The "updated Xs ago" text re-renders off this tick. Bumped every 30s
  // so the relative time stays fresh without us re-fetching the whole
  // payload — that happens every POLL_MS instead.
  const [tick, setTick] = useState(0);

  const token = localStorage.getItem("crimson-session");

  async function load(initial: boolean) {
    if (!token) return;
    if (!initial) setRefreshing(true);
    try {
      const res = await fetch("/api/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        // Session expired. Drop and re-login.
        localStorage.removeItem("crimson-session");
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as StatusResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load(true);
    const poll = setInterval(() => load(false), POLL_MS);
    const ticker = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(ticker);
    };
    // We deliberately don't depend on `token` — it doesn't change at runtime;
    // a session expiry will surface as a 401 inside load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group statuses by their pn/vx/tm prefix so the page renders one
  // section per provider. Memoized so re-rendering off `tick` doesn't
  // re-walk the array.
  const groups = useMemo(() => {
    const map = new Map<string, ModelStatus[]>();
    for (const m of data?.models ?? []) {
      const slash = m.id.indexOf("/");
      const prefix = slash >= 0 ? m.id.slice(0, slash) : "_";
      const list = map.get(prefix);
      if (list) list.push(m);
      else map.set(prefix, [m]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  // Build a prefix → owner lookup once per fetch so each section can
  // pull its "added by" chip in O(1).
  const ownersByPrefix = useMemo(() => {
    const map = new Map<string, ProviderOwner["owner"]>();
    for (const p of data?.providers ?? []) map.set(p.prefix, p.owner);
    return map;
  }, [data]);

  const generatedAtMs = data ? Date.parse(data.generatedAt) : 0;
  // Read `tick` so React re-renders when it bumps even though we don't
  // use the value directly — ensures "Xs ago" stays accurate.
  void tick;
  const ago = data ? formatAgo(Date.now() - generatedAtMs) : "";

  return (
    <div className="min-h-screen p-6 relative overflow-hidden">
      <div className="absolute inset-0 opacity-5 pointer-events-none">
        <div className="absolute top-10 left-10 text-6xl">🐱</div>
        <div className="absolute top-20 right-20 text-5xl">🌸</div>
        <div className="absolute bottom-20 left-20 text-5xl">🌺</div>
        <div className="absolute bottom-10 right-10 text-6xl">🏵️</div>
      </div>

      <div className="max-w-5xl mx-auto relative z-10">
        {/* Header — mirrors Dashboard.tsx so the page feels native. */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Activity className="w-8 h-8 text-primary" />
            <h1 className="text-primary text-2xl font-bold">Status</h1>
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
                href="/dashboard"
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
              >
                <LayoutDashboard className="w-4 h-4" />
                Dashboard
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

        {/* Summary bar above the model list. The `ago` text is the
            client-side ticker — re-renders every 30s without re-fetching. */}
        <div className="bg-card border-2 border-primary rounded-2xl p-5 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-primary font-semibold mb-1">Model health</p>
            <p className="text-xs text-muted-foreground">
              Last 20 requests per model · newer on the right ·{" "}
              <Square color="green" /> ok ·{" "}
              <Square color="yellow" /> slow (&gt;30s) ·{" "}
              <Square color="red" /> error
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {data ? `Updated ${ago}` : ""}
            </span>
            <button
              onClick={() => load(false)}
              disabled={refreshing}
              className="flex items-center gap-1 px-3 py-1.5 text-xs border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50 transition-colors"
              title="Force refresh"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="text-center py-16 text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="bg-destructive/10 border-2 border-destructive/50 rounded-2xl p-6 text-center">
            <p className="text-destructive font-semibold mb-1">
              Couldn't load status
            </p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="bg-card border-2 border-border rounded-2xl p-10 text-center text-muted-foreground">
            No models enabled yet.
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map(([prefix, models]) => (
              <ProviderSection
                key={prefix}
                prefix={prefix}
                models={models}
                owner={ownersByPrefix.get(prefix) ?? null}
              />
            ))}
          </div>
        )}

        <footer className="text-center mt-12 text-muted-foreground text-sm">
          <p>🐱 Made with love in a crimson cottage 🌸</p>
        </footer>
      </div>
    </div>
  );
}

// ─── Provider section ────────────────────────────────────────────────────

function ProviderSection({
  prefix,
  models,
  owner,
}: {
  prefix: string;
  models: ModelStatus[];
  owner: ProviderOwner["owner"];
}) {
  return (
    <div className="bg-card border-2 border-primary rounded-2xl p-5">
      {/* Header is the routing PREFIX (the public string users type as
          model: pn/foo). NOT the internal provider name (AI.md rule 6).
          When the provider row has an owner_id resolvable to a known
          Discord user we render a small "added by …" chip next to it;
          older rows / mock have owner_id=null and the chip is omitted. */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-primary font-bold text-lg font-mono">
          {prefix.toUpperCase()}
        </h2>
        {owner && (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={`Added by ${owner.username}`}
          >
            <span>added by</span>
            {owner.avatar ? (
              <img
                src={`https://cdn.discordapp.com/avatars/${owner.id}/${owner.avatar}.png?size=32`}
                alt=""
                className="w-5 h-5 rounded-full"
              />
            ) : (
              <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] text-primary">
                {owner.username.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="text-card-foreground font-medium">
              {owner.username}
            </span>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {models.map((m) => (
          <ModelRow key={m.id} model={m} />
        ))}
      </div>
    </div>
  );
}

// ─── One row ─────────────────────────────────────────────────────────────

function ModelRow({ model }: { model: ModelStatus }) {
  // The id is `pn/claude-opus-4-7`; strip the prefix because the
  // section header already carries it.
  const slash = model.id.indexOf("/");
  const bareId = slash >= 0 ? model.id.slice(slash + 1) : model.id;

  // Pad the bars array with `null` placeholders so partially-empty
  // strips render right-aligned (newer on the right). Without this,
  // a model with 4 bars would render those 4 squares left-aligned.
  const slots: (Bar | null)[] = new Array(model.window).fill(null);
  for (let i = 0; i < model.bars.length; i++) {
    // bars is newest-first from the server; we render right-to-left
    // chronologically so the rightmost square is "now". Index from
    // the right.
    slots[model.window - 1 - i] = model.bars[i];
  }

  // Click-to-copy: tapping the row copies the FULL prefixed id
  // (e.g. "pn/claude-opus-4-7") to the clipboard, which is exactly
  // what users paste into their chat client. We strip the prefix
  // visually because the section header already shows it, but the
  // copied value carries it so a paste works without editing.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(model.id);
      setCopied(true);
    } catch {
      // navigator.clipboard requires a secure context. On insecure
      // origins or older browsers, fall back to the textarea+execCommand
      // dance so the click isn't silently a no-op.
      const ta = document.createElement("textarea");
      ta.value = model.id;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        /* both methods failed — leave copied=false so no fake "Copied!" */
      }
      document.body.removeChild(ta);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy model id ${model.id}`}
      className="w-full flex items-center justify-between gap-4 hover:bg-muted/20 rounded-lg px-2 py-1 transition-colors group cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="font-mono text-sm text-card-foreground truncate min-w-0 flex-1 flex items-center gap-1.5">
        <span className="truncate">{bareId}</span>
        {copied ? (
          <span className="flex items-center gap-1 text-green-500 text-xs flex-shrink-0">
            <Check className="w-3.5 h-3.5" /> copied
          </span>
        ) : (
          <Copy className="w-3.5 h-3.5 text-muted-foreground opacity-25 group-hover:opacity-70 flex-shrink-0 transition-opacity" />
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {slots.map((b, i) =>
          b ? (
            <Square
              key={i}
              color={b.color}
              title={`${b.status} · ${formatDur(b.durationMs)} · ${formatAt(b.at)}`}
            />
          ) : (
            <Square key={i} color="gray" />
          ),
        )}
      </div>
    </button>
  );
}

// ─── Square primitive ────────────────────────────────────────────────────

function Square({
  color,
  title,
}: {
  color: "green" | "yellow" | "red" | "gray";
  title?: string;
}) {
  const cls =
    color === "green"
      ? "bg-green-500"
      : color === "yellow"
        ? "bg-yellow-500"
        : color === "red"
          ? "bg-red-500"
          : "bg-muted";
  return (
    <span
      title={title}
      className={`inline-block w-3 h-3 rounded-sm ${cls}`}
      aria-label={color}
    />
  );
}

// ─── Formatting helpers ──────────────────────────────────────────────────

function formatAgo(deltaMs: number): string {
  if (deltaMs < 5_000) return "just now";
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
