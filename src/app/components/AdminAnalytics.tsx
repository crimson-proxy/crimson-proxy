import { useEffect, useState } from "react";
import { Search, ChevronLeft, ChevronRight, Activity, AlertTriangle, Users, Database, Key, Trash2, Ban, MoreHorizontal, Clock, CheckCircle2, Coins } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { toast } from "sonner";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "./ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem("crimson-admin-token") ?? "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Compact token formatter. 1234 -> "1.2k", 1_500_000 -> "1.5M".
 * Used in tight table cells where the full count is too wide.
 */
function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Pull a short, glanceable summary out of a request_logs.error value.
 * Provider errors are typically of the form `"<provider>: <json>"`, where
 * the JSON contains a `message` and sometimes `data.flaggedCategories`.
 * We try to extract those; failing that we just truncate the raw string.
 */
function summarizeError(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const msg = typeof parsed.message === "string" ? parsed.message : "";
      const flagged = parsed.data?.flaggedCategories;
      if (Array.isArray(flagged) && flagged.length > 0) {
        return `${msg || "blocked"} [${flagged.join(", ")}]`;
      }
      if (msg) return msg;
    } catch {
      // fall through to plain truncation
    }
  }
  return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
}

type OverviewData = {
  requestsToday: number;
  errorsToday: number;
  promptTokensToday: number;
  completionTokensToday: number;
  totalTokensToday: number;
};

export function AdminAnalytics() {
  const [activeTab, setActiveTab] = useState<"leaderboard" | "logs" | "keys">("leaderboard");
  const [overview, setOverview] = useState<OverviewData | null>(null);

  useEffect(() => {
    fetch("/api/admin/overview", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) setOverview(data);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border-2 border-border rounded-xl p-6 flex items-center gap-4">
          <div className="bg-primary/10 p-4 rounded-full">
            <Activity className="w-8 h-8 text-primary" />
          </div>
          <div>
            <div className="text-sm text-muted-foreground font-medium">Requests Today</div>
            <div className="text-3xl font-bold text-foreground">
              {overview ? overview.requestsToday.toLocaleString() : "..."}
            </div>
          </div>
        </div>
        <div className="bg-card border-2 border-border rounded-xl p-6 flex items-center gap-4">
          <div className="bg-destructive/10 p-4 rounded-full">
            <AlertTriangle className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <div className="text-sm text-muted-foreground font-medium">Errors Today</div>
            <div className="text-3xl font-bold text-foreground">
              {overview ? overview.errorsToday.toLocaleString() : "..."}
            </div>
          </div>
        </div>
        <div className="bg-card border-2 border-border rounded-xl p-6 flex items-center gap-4">
          <div className="bg-yellow-500/10 p-4 rounded-full">
            <Coins className="w-8 h-8 text-yellow-600 dark:text-yellow-400" />
          </div>
          <div>
            <div className="text-sm text-muted-foreground font-medium">Tokens Today</div>
            <div className="text-3xl font-bold text-foreground" title={overview ? `${overview.totalTokensToday.toLocaleString()} total tokens` : ""}>
              {overview ? fmtTokens(overview.totalTokensToday) : "..."}
            </div>
            {overview && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {fmtTokens(overview.promptTokensToday)} in · {fmtTokens(overview.completionTokensToday)} out
              </div>
            )}
          </div>
        </div>
      </div>

      <Chart />

      {/* Tabs */}
      <div className="flex border-b-2 border-border gap-6">
        <button
          onClick={() => setActiveTab("leaderboard")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-0.5 flex items-center gap-2 ${
            activeTab === "leaderboard"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Users className="w-4 h-4" />
          User Leaderboard
        </button>
        <button
          onClick={() => setActiveTab("logs")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-0.5 flex items-center gap-2 ${
            activeTab === "logs"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Database className="w-4 h-4" />
          Raw Request Logs
        </button>
        <button
          onClick={() => setActiveTab("keys")}
          className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-0.5 flex items-center gap-2 ${
            activeTab === "keys"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Key className="w-4 h-4" />
          API Keys
        </button>
      </div>

      {activeTab === "leaderboard" && <LeaderboardTab />}
      {activeTab === "logs" && <LogsTab />}
      {activeTab === "keys" && <KeyManagerTab />}
    </div>
  );
}

/**
 * Small inline badge that renders a user's restriction state.
 * Pulled out of the table row so the leaderboard JSX stays readable
 * and the formatting logic lives in one place.
 */
function UserStatusBadge({ banType, expiresAt }: { banType: "ban" | "timeout" | null; expiresAt: string | null }) {
  if (banType === "ban") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-destructive/15 text-destructive border border-destructive/30">
        <Ban className="w-3 h-3" />
        Banned
      </span>
    );
  }
  if (banType === "timeout") {
    // Format the remaining time as "Xh Ym" when under 24h, otherwise the date.
    let remaining = "";
    if (expiresAt) {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (ms > 0) {
        const totalMins = Math.floor(ms / 60_000);
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        if (hours >= 24) {
          remaining = new Date(expiresAt).toLocaleDateString();
        } else if (hours > 0) {
          remaining = `${hours}h ${mins}m`;
        } else {
          remaining = `${mins}m`;
        }
      }
    }
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30"
        title={expiresAt ? `Timeout expires ${new Date(expiresAt).toLocaleString()}` : "Timeout"}
      >
        <Clock className="w-3 h-3" />
        Timeout{remaining ? ` · ${remaining}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/30">
      <CheckCircle2 className="w-3 h-3" />
      Active
    </span>
  );
}

function LeaderboardTab() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [sortBy, setSortBy] = useState("total_requests"); // total_requests, error_requests, last_request

  const [banModalOpen, setBanModalOpen] = useState(false);
  const [timeoutModalOpen, setTimeoutModalOpen] = useState(false);
  // banType describes the user's CURRENT state at the time the dropdown
  // opens: 'ban' = permanent ban, 'timeout' = timed out, null = clean.
  // The action dialogs key off this so the labels and confirm logic are
  // never ambiguous between Ban and Timeout.
  const [targetUser, setTargetUser] = useState<{
    id: string;
    banType: "ban" | "timeout" | null;
    expiresAt: string | null;
    username: string;
  } | null>(null);
  const [banReason, setBanReason] = useState("");
  const [timeoutReason, setTimeoutReason] = useState("");
  const [timeoutHours, setTimeoutHours] = useState("24");

  const limit = 10;

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ search, page: page.toString(), limit: limit.toString(), sortBy });
    try {
      const res = await fetch(`/api/admin/users/stats?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!data.error) {
        setUsers(data.users || []);
        setTotalCount(data.totalCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [page, sortBy]);

  // Both Ban and Timeout dialogs route through the same DB-level "remove
  // active row" endpoint when the user is already restricted. We use
  // /unban for the lift action because it correctly clears any active
  // row (ban OR timeout) for the user, and there's no behavioral reason
  // to maintain a separate /clear-timeout endpoint that would do the
  // same UPDATE.
  const submitBan = async () => {
    if (!targetUser) return;
    const banType = targetUser.banType;
    const isLift = banType !== null;
    const username = targetUser.username;
    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/${isLift ? "unban" : "ban"}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: banReason || "No reason provided" })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setBanModalOpen(false);
      setBanReason("");
      if (banType === "timeout") {
        toast.success(`⏳ Timeout removed for ${username}`, { description: "They can use the proxy again right meow~" });
      } else if (banType === "ban") {
        toast.success(`🌸 ${username} has been unbanned`, { description: "Welcome them back!" });
      } else {
        toast.success(`🚫 ${username} has been banned`, { description: "Their keys were revoked too." });
      }
      load();
    } catch (err) {
      toast.error("Nya... that didn't work", { description: (err as Error).message });
      console.error(err);
    }
  };

  const submitTimeout = async () => {
    if (!targetUser) return;
    const username = targetUser.username;
    const hours = Number(timeoutHours) || 24;
    try {
      const res = await fetch(`/api/admin/users/${targetUser.id}/timeout`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: timeoutReason || "No reason provided", hours })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setTimeoutModalOpen(false);
      setTimeoutReason("");
      setTimeoutHours("24");
      toast.success(`⏰ ${username} is in time-out`, { description: `They'll be back in ${hours}h. Keys revoked.` });
      load();
    } catch (err) {
      toast.error("Nya... that didn't work", { description: (err as Error).message });
      console.error(err);
    }
  };

  useEffect(() => {
    setPage(1);
    const t = setTimeout(load, 500); // debounce
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="bg-card border-2 border-border rounded-xl overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border flex items-center justify-between bg-muted/30">
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username or ID..."
            className="w-full pl-9 pr-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
        >
          <option value="total_requests">Sort by Most Requests</option>
          <option value="total_tokens">Sort by Most Tokens</option>
          <option value="error_requests">Sort by Most Errors</option>
          <option value="last_request">Sort by Recently Active</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted text-sm">
            <tr>
              <th className="text-left p-3">User</th>
              <th className="text-right p-3">Total Requests</th>
              <th className="text-right p-3">Tokens</th>
              <th className="text-right p-3">Errors</th>
              <th className="text-right p-3">Last Active</th>
              <th className="text-center p-3">Status</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={7} className="text-center p-8 text-muted-foreground">Loading...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={7} className="text-center p-8 text-muted-foreground">No users found.</td></tr>
            ) : (
              users.map((u, i) => (
                <tr key={u.discord_id} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground">
                        {u.avatar ? (
                          <img src={`https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png?size=32`} className="w-8 h-8 rounded-full" />
                        ) : (
                          (page - 1) * limit + i + 1
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{u.username}</div>
                        <div className="text-xs text-muted-foreground">{u.discord_id}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-right font-medium">{Number(u.total_requests).toLocaleString()}</td>
                  <td
                    className="p-3 text-right font-medium text-yellow-600 dark:text-yellow-400"
                    title={`${Number(u.prompt_tokens || 0).toLocaleString()} in · ${Number(u.completion_tokens || 0).toLocaleString()} out`}
                  >
                    {fmtTokens(Number(u.total_tokens || 0))}
                  </td>
                  <td className="p-3 text-right text-destructive">{Number(u.error_requests).toLocaleString()}</td>
                  <td className="p-3 text-right text-sm text-muted-foreground">
                    {u.last_request ? new Date(u.last_request).toLocaleString() : "Never"}
                  </td>
                  <td className="p-3 text-center">
                    <UserStatusBadge banType={u.ban_type ?? null} expiresAt={u.ban_expires_at ?? null} />
                  </td>
                  <td className="p-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="p-2 hover:bg-muted rounded transition-colors border border-transparent hover:border-border">
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {/* "Timeout User" only shows when the user is clean. */}
                        {!u.is_banned && (
                          <DropdownMenuItem
                            onClick={() => {
                              setTargetUser({ id: u.discord_id, banType: null, expiresAt: null, username: u.username });
                              setTimeoutModalOpen(true);
                            }}
                            className="text-yellow-600"
                          >
                            <Clock className="w-4 h-4 mr-2" />
                            Timeout User
                          </DropdownMenuItem>
                        )}
                        {/* For timed-out users, give a dedicated "Remove Timeout" entry
                            so the action label matches the state. */}
                        {u.ban_type === "timeout" && (
                          <DropdownMenuItem
                            onClick={() => {
                              setTargetUser({ id: u.discord_id, banType: "timeout", expiresAt: u.ban_expires_at ?? null, username: u.username });
                              setBanModalOpen(true);
                            }}
                            className="text-green-500"
                          >
                            <Clock className="w-4 h-4 mr-2" />
                            Remove Timeout
                          </DropdownMenuItem>
                        )}
                        {/* Ban / Unban entry. For permanent bans only. Timed-out
                            users use "Remove Timeout" above. */}
                        {u.ban_type !== "timeout" && (
                          <DropdownMenuItem
                            onClick={() => {
                              setTargetUser({ id: u.discord_id, banType: u.ban_type ?? null, expiresAt: u.ban_expires_at ?? null, username: u.username });
                              setBanModalOpen(true);
                            }}
                            className={u.ban_type === "ban" ? "text-green-500" : "text-destructive"}
                          >
                            <Ban className="w-4 h-4 mr-2" />
                            {u.ban_type === "ban" ? "Unban User" : "Ban User"}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-border flex items-center justify-between bg-muted/30">
        <div className="text-sm text-muted-foreground">
          Showing {users.length} of {totalCount.toLocaleString()} users
        </div>
        <div className="flex gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            disabled={page * limit >= totalCount}
            onClick={() => setPage(p => p + 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
      
      <AlertDialog open={banModalOpen} onOpenChange={setBanModalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {targetUser?.banType === "ban"
                ? `Unban ${targetUser.username}?`
                : targetUser?.banType === "timeout"
                ? `Remove timeout for ${targetUser.username}?`
                : `Ban ${targetUser?.username}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {targetUser?.banType === "ban"
                ? "This will lift the permanent ban. The user will be able to generate new API keys and use the proxy again."
                : targetUser?.banType === "timeout"
                ? `This will end the active timeout${targetUser.expiresAt ? ` (expires ${new Date(targetUser.expiresAt).toLocaleString()})` : ""}. The user can generate new API keys immediately.`
                : "This will instantly revoke all their active keys and block them from generating new ones."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="py-4">
              <label className="text-sm font-medium text-foreground mb-1 block">
                {targetUser?.banType ? "Lift Reason" : "Ban Reason"}
              </label>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder={targetUser?.banType ? "Appealed, mistake, etc..." : "Spamming, abuse, etc..."}
                className="w-full px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
              />
            </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={submitBan}
              className={targetUser?.banType ? "bg-green-500 text-white hover:bg-green-600" : "bg-destructive text-white hover:bg-destructive/90"}
            >
              {targetUser?.banType === "ban"
                ? "Yes, Unban User"
                : targetUser?.banType === "timeout"
                ? "Yes, Remove Timeout"
                : "Yes, Ban User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={timeoutModalOpen} onOpenChange={setTimeoutModalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Timeout {targetUser?.username}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will temporarily revoke all their keys and prevent them from using the service. They will be automatically unbanned when the time expires.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="py-2 space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                Timeout Duration (Hours)
              </label>
              <input 
                type="number" 
                value={timeoutHours}
                onChange={(e) => setTimeoutHours(e.target.value)}
                min="1"
                placeholder="24"
                className="w-full px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1 block">
                Reason
              </label>
              <input
                type="text"
                value={timeoutReason}
                onChange={(e) => setTimeoutReason(e.target.value)}
                placeholder="Ignoring rate limits, etc..."
                className="w-full px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={submitTimeout}
              className="bg-yellow-600 text-white hover:bg-yellow-700"
            >
              Confirm Timeout
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LogsTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  // The full error blob for the row the admin clicked. null = modal closed.
  // Held as the whole row so the modal can show user / model / via for
  // context in addition to the error itself.
  const [errorDetail, setErrorDetail] = useState<any | null>(null);

  const limit = 20;

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ search, status, page: page.toString(), limit: limit.toString() });
    try {
      const res = await fetch(`/api/admin/logs?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!data.error) {
        setLogs(data.logs || []);
        setTotalCount(data.totalCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [page, status]);

  useEffect(() => {
    setPage(1);
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="bg-card border-2 border-border rounded-xl overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-4 bg-muted/30">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search specific user..."
            className="w-full pl-9 pr-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
        >
          <option value="all">All Statuses</option>
          <option value="success">Success Only</option>
          <option value="error">Errors Only</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted text-sm">
            <tr>
              <th className="text-left p-3">Time</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Model</th>
              <th className="text-left p-3">Via</th>
              <th className="text-right p-3">Tokens</th>
              <th className="text-right p-3">Status</th>
              <th className="text-right p-3">Duration</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {loading && logs.length === 0 ? (
              <tr><td colSpan={7} className="text-center p-8 text-muted-foreground">Loading...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={7} className="text-center p-8 text-muted-foreground">No logs found.</td></tr>
            ) : (
              logs.map((l) => (
                <tr key={l.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="p-3 text-muted-foreground whitespace-nowrap">
                    {new Date(l.created_at).toLocaleTimeString()}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground">
                        {l.avatar && l.discord_user_id ? (
                          <img src={`https://cdn.discordapp.com/avatars/${l.discord_user_id}/${l.avatar}.png?size=32`} className="w-8 h-8 rounded-full" />
                        ) : (
                          <Users className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{l.discord_username || "Anonymous"}</div>
                        {l.discord_user_id && <div className="text-[10px] text-muted-foreground font-normal">{l.discord_user_id}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="p-3">
                    <span className="bg-accent px-2 py-1 rounded text-xs">{l.model || l.endpoint}</span>
                  </td>
                  <td className="p-3 text-xs">
                    {l.provider_prefix || l.via ? (
                      <span className="bg-muted px-2 py-1 rounded font-mono">{l.provider_prefix || l.via}</span>
                    ) : (
                      <span className="text-muted-foreground opacity-50">—</span>
                    )}
                  </td>
                  <td
                    className="p-3 text-right text-xs"
                    title={
                      l.total_tokens != null
                        ? `${Number(l.prompt_tokens || 0).toLocaleString()} in · ${Number(l.completion_tokens || 0).toLocaleString()} out`
                        : "no token data"
                    }
                  >
                    {l.total_tokens != null ? (
                      <span className="text-yellow-600 dark:text-yellow-400 font-medium">
                        {fmtTokens(Number(l.total_tokens))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground opacity-50">—</span>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {l.status >= 400 ? (
                      // Error rows are CLICKABLE — open a modal with the
                      // full message so a 1KB stack trace can't blow out
                      // the table column. Inline we ONLY show the status
                      // code (no error text, no error_type) — the user
                      // wants the table cell minimal so the row layout
                      // stays tidy regardless of how long the error
                      // message is. Underline + cursor signal the row
                      // is interactive.
                      <button
                        type="button"
                        onClick={() => setErrorDetail(l)}
                        className="text-destructive font-bold underline decoration-dotted underline-offset-2 hover:bg-destructive/10 -mx-2 px-2 py-1 rounded transition-colors"
                        title="Click to see the full error"
                      >
                        {l.status}
                      </button>
                    ) : (
                      <span className="text-green-500 font-bold">{l.status}</span>
                    )}
                  </td>
                  <td className="p-3 text-right text-muted-foreground">{l.duration_ms}ms</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-border flex items-center justify-between bg-muted/30">
        <div className="text-sm text-muted-foreground">
          Showing {logs.length} of {totalCount} logs
        </div>
        <div className="flex gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            disabled={page * limit >= totalCount}
            onClick={() => setPage(p => p + 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Error-detail modal. Opens when an admin clicks any error row's
          status cell. Shows the row's full context (user / model / via /
          status / duration) plus the entire error blob in a scrollable
          monospace block — no truncation, so a multi-KB stack trace
          can't overflow the table cell or get cut off.
          Closing the modal sets errorDetail back to null. */}
      <Dialog
        open={errorDetail !== null}
        onOpenChange={(open) => { if (!open) setErrorDetail(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              <span className="text-destructive font-mono">
                {errorDetail?.status}
                {errorDetail?.error_type ? ` · ${errorDetail.error_type}` : ""}
              </span>
            </DialogTitle>
            <DialogDescription>
              {errorDetail
                ? `${errorDetail.discord_username ?? "Anonymous"}'s request at ${new Date(errorDetail.created_at).toLocaleString()}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {errorDetail && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div>
                  <div className="text-muted-foreground mb-0.5">Model</div>
                  <div className="font-mono break-all">{errorDetail.model || errorDetail.endpoint || "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Via</div>
                  <div className="font-mono">{errorDetail.provider_prefix ?? errorDetail.via ?? "—"}</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Duration</div>
                  <div className="font-mono">{errorDetail.duration_ms}ms</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">User ID</div>
                  <div className="font-mono break-all">{errorDetail.discord_user_id ?? "—"}</div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted-foreground">Error message</div>
                  {errorDetail.error && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(errorDetail.error);
                          toast.success("Copied error to clipboard");
                        } catch {
                          toast.error("Couldn't copy");
                        }
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Copy
                    </button>
                  )}
                </div>
                <pre className="bg-muted/50 border border-border rounded-lg p-3 max-h-80 overflow-auto text-xs whitespace-pre-wrap break-words font-mono">
                  {errorDetail.error || <span className="text-muted-foreground italic">(no message captured)</span>}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Chart() {
  const [data, setData] = useState<
    { bucketStart?: string; requests: number; errors: number }[]
  >([]);

  useEffect(() => {
    fetch("/api/admin/chart", { headers: authHeaders() })
      .then((r) => r.json())
      .then((res) => {
        if (!res.error) setData(res.chartData || []);
      })
      .catch(console.error);
  }, []);

  if (data.length === 0) return null;

  const hourFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    hour12: false,
  });

  const chartData = data.map((d) => ({
    bucketStart: d.bucketStart,
    time: (() => {
      if (!d.bucketStart) return "";
      const parsed = new Date(d.bucketStart);
      if (Number.isNaN(parsed.getTime())) return "";
      return hourFormatter.format(parsed);
    })(),
    success: d.requests - d.errors,
    errors: d.errors,
  }));

  return (
    <div className="bg-card border-2 border-border rounded-xl p-4 h-64" title="Last 24 hours (local time)">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
          <XAxis dataKey="time" stroke="#888" fontSize={10} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={10} />
          <YAxis stroke="#888" fontSize={10} tickLine={false} axisLine={false} />
          <Tooltip 
            contentStyle={{ backgroundColor: "#1a1a1a", borderColor: "#333", borderRadius: "8px" }}
            itemStyle={{ color: "#fff" }}
            labelFormatter={(_, payload) => {
              const raw = payload?.[0]?.payload?.bucketStart;
              if (typeof raw !== "string") return String(_);
              const parsed = new Date(raw);
              if (Number.isNaN(parsed.getTime())) return String(_);
              return parsed.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              });
            }}
          />
          <Line type="monotone" dataKey="success" stroke="#22c55e" strokeWidth={3} dot={false} name="Successful Requests" />
          <Line type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={3} dot={false} name="Errors" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function KeyManagerTab() {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 20;

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, page: page.toString(), limit: limit.toString() });
      const res = await fetch(`/api/admin/keys?${params}`, { headers: authHeaders() });
      const data = await res.json();
      if (!data.error) {
        setKeys(data.keys || []);
        setTotalCount(data.totalCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [page]);

  useEffect(() => {
    setPage(1);
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [search]);

  const [revokeModalOpen, setRevokeModalOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: number; username: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    const username = revokeTarget.username;
    try {
      const res = await fetch(`/api/admin/keys/${revokeTarget.id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: revokeReason || "No reason provided" })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setRevokeModalOpen(false);
      setRevokeReason("");
      toast.success(`🔑 Key revoked`, { description: `${username}'s key won't work anymore.` });
      load();
    } catch (err) {
      toast.error("Nya... couldn't revoke that key", { description: (err as Error).message });
      console.error(err);
    }
  };

  return (
    <div className="bg-card border-2 border-border rounded-xl overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border flex items-center justify-between bg-muted/30">
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username or ID..."
            className="w-full pl-9 pr-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          {totalCount} active key{totalCount !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted text-sm">
            <tr>
              <th className="text-left p-3">Owner</th>
              <th className="text-left p-3">Key Preview</th>
              <th className="text-left p-3">Created</th>
              <th className="text-left p-3">Last Used</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {loading ? (
              <tr><td colSpan={5} className="text-center p-8 text-muted-foreground">Loading...</td></tr>
            ) : keys.length === 0 ? (
              <tr><td colSpan={5} className="text-center p-8 text-muted-foreground">{search ? "No keys matching your search." : "No active API keys."}</td></tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground">
                        {k.avatar ? (
                          <img src={`https://cdn.discordapp.com/avatars/${k.discord_user_id}/${k.avatar}.png?size=32`} className="w-8 h-8 rounded-full" />
                        ) : (
                          <Users className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{k.discord_username || "Unknown"}</div>
                        {k.discord_user_id && <div className="text-[10px] text-muted-foreground font-normal">{k.discord_user_id}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-muted-foreground bg-muted/30 rounded px-2">{k.key_preview || "Unknown"}</td>
                  <td className="p-3 text-muted-foreground whitespace-nowrap">
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-muted-foreground whitespace-nowrap">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "Never"}
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => { setRevokeTarget({ id: k.id, username: k.discord_username || "Unknown" }); setRevokeModalOpen(true); }}
                      className="p-2 bg-destructive/10 text-destructive hover:bg-destructive hover:text-white rounded transition-colors"
                      title="Revoke Key"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-border flex items-center justify-between bg-muted/30">
        <div className="text-sm text-muted-foreground">
          Page {page} of {Math.max(1, Math.ceil(totalCount / limit))}
        </div>
        <div className="flex gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            disabled={page * limit >= totalCount}
            onClick={() => setPage(p => p + 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <AlertDialog open={revokeModalOpen} onOpenChange={setRevokeModalOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key for {revokeTarget?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently invalidate this key. The user will need to generate a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium text-foreground mb-1 block">Revocation Reason</label>
            <input
              type="text"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="Abuse, compromised, user request, etc..."
              className="w-full px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={submitRevoke}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Revoke Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ActionLogsTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 20;

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ search, page: page.toString(), limit: limit.toString() });
      if (actionFilter) params.set("action", actionFilter);
      const res = await fetch(`/api/admin/action-logs?${params}`, { headers: authHeaders() });
      const d = await res.json();
      if (!d.error) {
        setLogs(d.logs || []);
        setTotalCount(d.totalCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [page]);

  useEffect(() => {
    setPage(1);
    const t = setTimeout(load, 500);
    return () => clearTimeout(t);
  }, [search, actionFilter]);

  return (
    <div className="bg-card border-2 border-border rounded-xl overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-4 bg-muted/30 flex-wrap">
        <div className="relative w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user or admin ID..."
            className="w-full pl-9 pr-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-2 bg-input-background border-2 border-border rounded-lg text-sm focus:outline-none focus:border-primary"
        >
          <option value="">All Actions</option>
          <optgroup label="Users & keys">
            <option value="BAN_USER">Ban User</option>
            <option value="UNBAN_USER">Unban User</option>
            <option value="REVOKE_KEY">Revoke Key</option>
            <option value="CREATE_KEY">Create Key</option>
            <option value="REGENERATE_KEY">Regenerate Key</option>
          </optgroup>
          <optgroup label="Limits & config">
            <option value="UPDATE_CONFIG">Update Config</option>
            <option value="CREATE_TIER">Create Tier</option>
            <option value="UPDATE_TIER">Update Tier</option>
            <option value="DELETE_TIER">Delete Tier</option>
            <option value="UPDATE_PROVIDER">Update Provider</option>
            <option value="UPSERT_TIER_PROVIDER">Set Tier→Provider Override</option>
            <option value="DELETE_TIER_PROVIDER">Clear Tier→Provider Override</option>
          </optgroup>
        </select>
        <div className="text-sm text-muted-foreground ml-auto">
          {totalCount} total action{totalCount !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted text-sm">
            <tr>
              <th className="text-left p-4">User</th>
              <th className="text-left p-4">Action</th>
              <th className="text-left p-4">Reason</th>
              <th className="text-left p-4">Admin</th>
              <th className="text-right p-4">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center p-8 text-muted-foreground">Loading logs...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={5} className="text-center p-8 text-muted-foreground">{search || actionFilter ? "No actions matching your filters." : "No actions recorded yet."}</td></tr>
            ) : (
              logs.map((l) => (
                <tr key={`${l.id}`} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground border-2 border-transparent">
                        {l.target_avatar ? (
                          <img src={`https://cdn.discordapp.com/avatars/${l.target_id}/${l.target_avatar}.png?size=32`} className="w-full h-full rounded-full" />
                        ) : (
                          "?"
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-foreground text-sm">{l.target_username || l.target_id}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider ${
                      l.action === 'BAN_USER' ? 'bg-destructive/10 text-destructive' :
                      l.action === 'UNBAN_USER' ? 'bg-green-500/10 text-green-500' :
                      l.action === 'REVOKE_KEY' ? 'bg-yellow-500/10 text-yellow-500' :
                      'bg-primary/10 text-primary'
                    }`}>
                      {l.action.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-foreground max-w-[200px] truncate" title={l.reason || "No reason"}>
                    {l.reason || <span className="text-muted-foreground italic">None</span>}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center font-bold text-xs text-muted-foreground">
                        {l.actor_avatar ? (
                          <img src={`https://cdn.discordapp.com/avatars/${l.actor_id}/${l.actor_avatar}.png?size=32`} className="w-full h-full rounded-full" />
                        ) : (
                          "?"
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-foreground text-sm">{l.actor_username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-right text-sm text-muted-foreground font-mono">
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-border flex items-center justify-between bg-muted/30">
        <div className="text-sm text-muted-foreground">
          Page {page} of {Math.max(1, Math.ceil(totalCount / limit))}
        </div>
        <div className="flex gap-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            disabled={page * limit >= totalCount}
            onClick={() => setPage(p => p + 1)}
            className="p-2 border-2 border-border rounded-lg hover:bg-accent disabled:opacity-50"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
