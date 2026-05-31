import { useEffect, useState } from "react";
import {
  Cat,
  RefreshCw,
  Check,
  AlertCircle,
  LogOut,
  Activity,
} from "lucide-react";
import { AdminAnalytics, ActionLogsTab } from "./AdminAnalytics";
import { LimitsConfig } from "./LimitsConfig";

/**
 * Admin-only page. Routed via /admin (see App.tsx). NOT linked from
 * anywhere normal users see. Access is role-gated by Discord — see
 * POST /api/admin/login on the server.
 */

const STORAGE_KEY = "crimson-admin-token";

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem(STORAGE_KEY) ?? "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Toast system (lightweight, no library)
// ────────────────────────────────────────────────────────────────────────

type Toast = { id: number; kind: "success" | "error" | "info"; text: string };

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };

  return {
    toasts,
    success: (t: string) => push("success", t),
    error: (t: string) => push("error", t),
    info: (t: string) => push("info", t),
  };
}

function ToastRack({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-lg shadow-lg border-2 max-w-sm ${
            t.kind === "success"
              ? "bg-green-50 border-green-500 text-green-900"
              : t.kind === "error"
                ? "bg-red-50 border-red-500 text-red-900"
                : "bg-blue-50 border-blue-500 text-blue-900"
          }`}
        >
          <div className="flex items-start gap-2">
            {t.kind === "success" && <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />}
            {t.kind === "error" && <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
            <span className="text-sm">{t.text}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Role-based admin gate (auto-checks Discord role on mount)
// ────────────────────────────────────────────────────────────────────────

function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sessionToken = localStorage.getItem("crimson-session");

  useEffect(() => {
    if (!sessionToken) return;
    verifyAdmin();
  }, []);

  async function verifyAdmin() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Access denied");
        setLoading(false);
        return;
      }
      sessionStorage.setItem(STORAGE_KEY, data.token!);
      onAuthed();
    } catch {
      setError("Network error");
      setLoading(false);
    }
  }

  // Must be logged in via Discord first.
  if (!sessionToken) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-card border-2 border-primary rounded-2xl p-8 max-w-md w-full shadow-2xl text-center">
          <div className="flex justify-center mb-6">
            <div className="bg-primary rounded-full p-4">
              <Cat className="w-12 h-12 text-primary-foreground" />
            </div>
          </div>
          <h1 className="mb-2 text-primary">Admin Panel</h1>
          <p className="text-muted-foreground mb-6">
            You need to log in with Discord first.
          </p>
          <a
            href="/login"
            className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-3 rounded-lg transition-colors w-full"
          >
            Login with Discord
          </a>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-card border-2 border-primary rounded-2xl p-8 max-w-md w-full shadow-2xl text-center">
          <div className="flex justify-center mb-6">
            <div className="bg-primary rounded-full p-4">
              <Cat className="w-12 h-12 text-primary-foreground" />
            </div>
          </div>
          <h1 className="mb-2 text-primary">Admin Panel</h1>
          <p className="text-muted-foreground mb-4">Verifying access...</p>
          <div className="flex justify-center">
            <RefreshCw className="w-6 h-6 text-primary animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  // Access denied
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-card border-2 border-primary rounded-2xl p-8 max-w-md w-full shadow-2xl text-center">
        <div className="flex justify-center mb-6">
          <div className="bg-primary rounded-full p-4">
            <Cat className="w-12 h-12 text-primary-foreground" />
          </div>
        </div>
        <h1 className="mb-2 text-primary">Admin Panel</h1>
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 mb-4">
          <p className="text-2xl mb-2">🙀</p>
          <p className="text-sm font-medium text-destructive">
            {error?.includes("admin access")
              ? "Nya~ you don't have the right role for this!"
              : error?.includes("session")
                ? "Nya~ your Discord session expired!"
                : "Nyaa... something went wrong!"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{error}</p>
        </div>
        <a
          href="/"
          className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2 rounded-lg transition-colors"
        >
          Go Home
        </a>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Main panel (tabs: analytics / limits / action logs)
// ────────────────────────────────────────────────────────────────────────

function MainPanel() {
  const toasts = useToasts();
  // Which top-level tab is showing. Persisted in localStorage so a
  // refresh lands you back where you were.
  const [mainTab, setMainTab] = useState<"analytics" | "limits" | "actionlogs">(
    () => {
      if (typeof window === "undefined") return "analytics";
      const saved = window.localStorage.getItem("admin.mainTab");
      return saved === "analytics" ||
        saved === "limits" ||
        saved === "actionlogs"
        ? saved
        : "analytics";
    },
  );
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("admin.mainTab", mainTab);
    }
  }, [mainTab]);

  const logout = () => {
    localStorage.removeItem("crimson-session");
    sessionStorage.removeItem(STORAGE_KEY);
    window.location.href = "/";
  };

  return (
    <div className="min-h-screen p-6 max-w-6xl mx-auto">
      <ToastRack toasts={toasts.toasts} />

      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Cat className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-2xl text-primary font-bold">Admin Panel</h1>
            <p className="text-sm text-muted-foreground">
              Analytics, limits, and audit
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/dashboard"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            <Cat className="w-4 h-4" />
            Dashboard
          </a>
          <a
            href="/status"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            <Activity className="w-4 h-4" />
            Status
          </a>
          <button
            onClick={logout}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-destructive transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </header>

      <div className="flex border-b-2 border-border mb-6 gap-6">
        <button
          onClick={() => setMainTab("analytics")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-[2px] ${
            mainTab === "analytics"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Analytics & Logs
        </button>
        <button
          onClick={() => setMainTab("limits")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-[2px] ${
            mainTab === "limits"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Limits & Config
        </button>
        <button
          onClick={() => setMainTab("actionlogs")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-[2px] ${
            mainTab === "actionlogs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Action Logs
        </button>
      </div>

      {mainTab === "analytics" ? (
        <AdminAnalytics />
      ) : mainTab === "limits" ? (
        <LimitsConfig />
      ) : (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <ActionLogsTab />
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Top-level
// ────────────────────────────────────────────────────────────────────────

export function AdminPage() {
  const sessionToken = localStorage.getItem("crimson-session");
  const hasAdminToken = Boolean(sessionStorage.getItem(STORAGE_KEY));

  // If the Discord session is gone, the admin token is stale — clear it.
  if (!sessionToken && hasAdminToken) {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  const [authed, setAuthed] = useState(
    () => Boolean(sessionToken) && hasAdminToken,
  );

  if (!authed) {
    return <AdminLogin onAuthed={() => setAuthed(true)} />;
  }
  return <MainPanel />;
}
