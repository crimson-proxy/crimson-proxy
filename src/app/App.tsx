import { useState, useEffect } from "react";
import { installFetchRetry } from "./lib/fetch-retry";
import { LandingPage } from "./components/LandingPage";

// FUCK CLOUDFLARE FIX — install global fetch retry once at module load so
// every API call in the app silently retries on 5xx / network errors.
installFetchRetry();

import { LoginPage } from "./components/LoginPage";
import { RulesModal } from "./components/RulesModal";
import { Dashboard } from "./components/Dashboard";
import { AdminPage } from "./components/AdminPage";
import { StatusPage } from "./components/StatusPage";
import { Toaster } from "./components/ui/sonner";

type SessionUser = {
  id: string;
  username: string;
  avatar: string | null;
};

export default function App() {
  const path =
    typeof window !== "undefined" ? window.location.pathname : "/";

  // Admin panel has its own auth flow (password + admin JWT).
  if (path === "/admin") {
    return (
      <>
        <AdminPage />
        <Toaster position="bottom-right" richColors closeButton />
      </>
    );
  }

  const [user, setUser] = useState<SessionUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasAcceptedRules, setHasAcceptedRules] = useState(false);

  useEffect(() => {
    const accepted = localStorage.getItem("crimson-rules-accepted");
    if (accepted === "true") {
      setHasAcceptedRules(true);
    }

    const token = localStorage.getItem("crimson-session");
    if (!token) {
      setLoading(false);
      return;
    }

    fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error("expired");
        return res.json() as Promise<{ user: SessionUser; isAdmin?: boolean }>;
      })
      .then((data) => {
        setUser(data.user);
        setIsAdmin(data.isAdmin ?? false);
      })
      .catch(() => localStorage.removeItem("crimson-session"))
      .finally(() => setLoading(false));
  }, []);

  function handleLogin(token: string, sessionUser: SessionUser, isAdminFlag: boolean) {
    localStorage.setItem("crimson-session", token);
    setUser(sessionUser);
    setIsAdmin(isAdminFlag);
    window.history.replaceState({}, "", "/dashboard");
  }

  function handleLogout() {
    localStorage.removeItem("crimson-session");
    sessionStorage.removeItem("crimson-admin-token");
    setUser(null);
    window.location.href = "/";
  }

  // Choose which page to render based on the current path/auth state,
  // then mount the Toaster once at the bottom so every page can call
  // toast.success() / toast.error() without re-mounting it per route.
  let page: React.ReactNode;
  if (loading) {
    page = (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading...</div>
      </div>
    );
  } else if (path === "/") {
    page = <LandingPage />;
  } else if (path === "/login") {
    if (user) {
      window.location.href = "/dashboard";
      return null;
    }
    page = <LoginPage onLogin={handleLogin} />;
  } else if (path === "/dashboard") {
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    if (!hasAcceptedRules) {
      page = (
        <>
          <Dashboard user={user} onLogout={handleLogout} isAdmin={isAdmin} />
          <RulesModal
            onAccept={() => {
              setHasAcceptedRules(true);
              localStorage.setItem("crimson-rules-accepted", "true");
            }}
          />
        </>
      );
    } else {
      page = <Dashboard user={user} onLogout={handleLogout} isAdmin={isAdmin} />;
    }
  } else if (path === "/status") {
    // Same auth gate as /dashboard. The page itself fetches /api/status
    // with the session JWT — server returns 401 for anyone without it,
    // and the page's load() drops the stale token + redirects to /login
    // if that happens mid-session.
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    page = <StatusPage user={user} onLogout={handleLogout} isAdmin={isAdmin} />;
  } else {
    page = <LandingPage />;
  }

  return (
    <>
      {page}
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
