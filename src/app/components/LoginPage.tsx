import { useState, useEffect } from "react";
import { Cat, LogIn, Loader2, AlertTriangle } from "lucide-react";

interface LoginPageProps {
  onLogin: (token: string, user: { id: string; username: string; avatar: string | null }, isAdmin: boolean) => void;
}

type AuthState = "idle" | "loading" | "error";

export function LoginPage({ onLogin }: LoginPageProps) {
  const [state, setState] = useState<AuthState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Check if we're returning from Discord with a code.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthError = params.get("error");

    if (oauthError) {
      setError(
        oauthError === "access_denied"
          ? "You cancelled the Discord login."
          : `Discord error: ${oauthError}`,
      );
      // Clean the URL.
      window.history.replaceState({}, "", "/login");
      return;
    }

    if (code) {
      exchangeCode(code);
    }
  }, []);

  async function exchangeCode(code: string) {
    setState("loading");
    setError(null);

    try {
      const res = await fetch("/api/auth/discord/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          redirectUri: `${window.location.origin}/login`,
        }),
      });

      const data = (await res.json()) as {
        token?: string;
        user?: { id: string; username: string; avatar: string | null };
        isAdmin?: boolean;
        error?: string;
      };

      if (!res.ok || !data.token || !data.user) {
        setError(data.error ?? "Authentication failed. Please try again.");
        setState("error");
        // Clean the URL so a refresh doesn't re-attempt the dead code.
        window.history.replaceState({}, "", "/login");
        return;
      }

      onLogin(data.token, data.user, data.isAdmin ?? false);
    } catch (err) {
      setError("Network error. Is the server running?");
      setState("error");
      window.history.replaceState({}, "", "/login");
    }
  }

  async function handleLogin() {
    setState("loading");
    setError(null);

    try {
      // Ask the server for the Discord client ID.
      const configRes = await fetch("/api/auth/config");
      const configData = (await configRes.json()) as { clientId?: string; error?: string };

      if (!configRes.ok || !configData.clientId) {
        setError(configData.error ?? "Server is not configured for Discord login.");
        setState("error");
        return;
      }

      // Build the Discord OAuth2 authorize URL and redirect.
      const params = new URLSearchParams({
        client_id: configData.clientId,
        redirect_uri: `${window.location.origin}/login`,
        response_type: "code",
        scope: "identify",
      });

      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch {
      setError("Could not reach the server. Is it running?");
      setState("error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 opacity-10">
        <div className="absolute top-20 left-20 text-8xl">🌸</div>
        <div className="absolute bottom-20 right-20 text-8xl">🌺</div>
        <div className="absolute top-40 right-40 text-6xl">🌹</div>
        <div className="absolute bottom-40 left-40 text-6xl">🏵️</div>
      </div>

      <div className="relative bg-card border-2 border-primary rounded-2xl p-8 max-w-md w-full shadow-2xl">
        <div className="flex justify-center mb-6">
          <div className="bg-primary rounded-full p-4">
            <Cat className="w-12 h-12 text-primary-foreground" />
          </div>
        </div>

        <h1 className="text-center mb-2 text-primary">Crimson's Proxy</h1>
        <p className="text-center text-muted-foreground mb-6">
          Login with Discord to continue
        </p>

        {error && (
          <div className="relative bg-destructive/10 border-2 border-destructive/30 rounded-xl p-4 mb-4 overflow-hidden">
            {/* Falling cats animation */}
            <style>{`
              @keyframes fall {
                0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
                100% { transform: translateY(80px) rotate(360deg); opacity: 0; }
              }
              .falling-cat { animation: fall 2s ease-in infinite; }
              .falling-cat:nth-child(2) { animation-delay: 0.4s; left: 25%; }
              .falling-cat:nth-child(3) { animation-delay: 0.8s; left: 50%; }
              .falling-cat:nth-child(4) { animation-delay: 1.2s; left: 75%; }
              .falling-cat:nth-child(5) { animation-delay: 1.6s; left: 90%; }
            `}</style>
            <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-30">
              {[1,2,3,4,5].map(i => (
                <span key={i} className="falling-cat absolute top-0 text-lg" style={{ left: `${i * 15}%` }}>😿</span>
              ))}
            </div>
            <div className="text-center relative z-10">
              <p className="text-3xl mb-2">😿</p>
              <p className="text-sm font-medium text-destructive mb-1">
                {error.includes("cancelled")
                  ? "Nya... you left me hanging!"
                  : error.includes("Not a member")
                    ? "Nya?! You need to join our server first!"
                    : error.includes("required role")
                      ? "Nya~ you need the verified role to enter!"
                      : error.includes("not configured")
                        ? "Nya?! The server isn't set up yet..."
                        : "Nyaa... something went wrong!"}
              </p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        <button
          onClick={handleLogin}
          disabled={state === "loading"}
          className="w-full bg-primary hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed text-primary-foreground py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {state === "loading" ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Authenticating...
            </>
          ) : (
            <>
              <LogIn className="w-5 h-5" />
              Login with Discord
            </>
          )}
        </button>

        <div className="mt-6 text-center text-xs text-muted-foreground">
          🐱 A cozy cottage in the digital woods 🌿
        </div>
      </div>
    </div>
  );
}
