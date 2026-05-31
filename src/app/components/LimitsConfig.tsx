import { Fragment, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  Save,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  Layers,
  Server,
  Check,
  Loader2,
  X,
  Stethoscope,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Admin "Limits & Config" tab.
 *
 * CRUD over the DB config that drives lib/usage-limit.ts + lib/app-config.ts:
 *   - Global: app_config (discord ids + global RPM/RPD/TPD default budget)
 *   - Tiers:  Discord-role → limit overrides, incl. per-provider overrides
 *   - Providers: per-provider per-user + all-users caps, enable flag
 *
 * Every save calls the admin API, which writes an action_logs row — so the
 * existing "Analytics & Logs → Action Logs" tab IS the edit history (who
 * changed what, when). No separate audit view here on purpose.
 *
 * Blank number = "not enforced" (NULL). Resolution order is documented
 * inline so the operator doesn't have to remember it.
 */

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem("crimson-admin-token") ?? "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** Empty string <-> null at the API boundary; UI keeps strings. */
function numStr(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

async function api(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    sessionStorage.removeItem("crimson-admin-token");
    window.location.reload();
    return { ok: false, data: {} };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const inputCls =
  "w-full px-3 py-2 bg-input-background border-2 border-border rounded-lg focus:outline-none focus:border-primary text-sm";
const numCls =
  "w-28 px-2 py-1.5 bg-input-background border-2 border-border rounded-lg focus:outline-none focus:border-primary text-sm";
const btnPrimary =
  "bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2";
const btnGhost =
  "px-3 py-2 border-2 border-border rounded-lg hover:bg-accent transition-colors flex items-center gap-2";

// ─── Global (app_config) ───────────────────────────────────────────────

const CONFIG_FIELDS: Array<{
  key: string;
  label: string;
  hint: string;
  numeric?: boolean;
}> = [
  { key: "discord_server_id", label: "Discord Server ID", hint: "Guild the bot/role checks run against. Blank = use env." },
  { key: "discord_required_role_id", label: "Required Role ID", hint: "Role needed to get an API key / dashboard. Blank = use env." },
  { key: "discord_admin_role_ids", label: "Admin Role IDs", hint: "Comma-separated. Any of these grants admin. Blank = use env." },
  { key: "discord_staff_channel_id", label: "Staff Channel ID", hint: "Where low-pool alerts post. Blank = use env." },
  { key: "discord_status_channel_id", label: "Status Board Channel ID", hint: "Channel where the live model-health board posts/edits. Blank = feature disabled." },
  { key: "global_rpm", label: "Global RPM", hint: "Default requests/min per user. Blank = hardcoded 5.", numeric: true },
  { key: "global_rpd", label: "Global RPD", hint: "Default requests/day per user. Blank = hardcoded 200.", numeric: true },
  { key: "global_tpd", label: "Global TPD", hint: "Default tokens/day per user. Blank = hardcoded 5,000,000.", numeric: true },
];

function GlobalPanel() {
  const [cfg, setCfg] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const { ok, data } = await api("/api/admin/config", "GET");
    if (ok) setCfg(data.config ?? {});
    else toast.error(data.error ?? "Failed to load config");
  };
  useEffect(() => {
    load();
  }, []);

  if (!cfg) {
    return <div className="text-muted-foreground py-10 text-center">Loading…</div>;
  }

  const save = async () => {
    setSaving(true);
    try {
      const { ok, data } = await api("/api/admin/config", "PUT", cfg);
      if (ok) toast.success("Global config saved");
      else toast.error(data.error ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border-2 border-border rounded-xl p-6 space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-primary">Global defaults</h3>
        <p className="text-sm text-muted-foreground">
          DB value overrides the env var. Resolution per user:{" "}
          <span className="font-medium">tier → global → hardcoded</span>.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {CONFIG_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-sm mb-1">{f.label}</label>
            <input
              className={inputCls}
              inputMode={f.numeric ? "numeric" : "text"}
              value={cfg[f.key] ?? ""}
              onChange={(e) =>
                setCfg({ ...cfg, [f.key]: e.target.value })
              }
              placeholder={f.numeric ? "blank = default" : "blank = use env"}
            />
            <p className="text-xs text-muted-foreground mt-1">{f.hint}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={saving} onClick={save}>
          <Save className="w-4 h-4" />
          {saving ? "Saving…" : "Save global config"}
        </button>
        <button className={btnGhost} onClick={load} disabled={saving}>
          <RefreshCw className="w-4 h-4" />
          Reset
        </button>
      </div>
    </div>
  );
}

// ─── Providers ─────────────────────────────────────────────────────────
//
// Two kinds of provider rows:
//   - kind='openai'  → DB-driven OpenAI-compatible (VixAI, OpenRouter,
//                       anything an admin adds). Full CRUD: base URL, key,
//                       prefix, a refreshable model catalog with per-model
//                       masking + enable, and the limit gates.
//   - kind='builtin' → wired in code. Only display name / enabled /
//                       limits are editable.
// Mock stays hidden here — it's a code-only test provider.

type Provider = {
  id: string;
  display_name: string;
  enabled: boolean;
  /** Enabled-but-invisible = callable but hidden from the models list and
   *  status board. Only meaningful when enabled. */
  visible: boolean;
  kind: "openai" | "builtin";
  prefix: string;
  // Server returns "" for non-owners (creds are owner-gated). Trust
  // viewer_is_owner / has_base_url, NOT the string emptiness, when
  // deciding what to render — empty also means "owner with no URL set".
  base_url: string;
  has_base_url: boolean;
  has_api_key: boolean;
  extra_headers: Record<string, string> | null;
  models_synced_at: string | null;
  model_count: number;
  model_enabled_count: number;
  // Admin-only attribution — never shown to end users.
  owner_id: string | null;
  owner: { id: string; username: string; avatar: string | null } | null;
  /** True when this admin's discord id matches owner_id. Owner-only
   *  controls (edit base url / api key / refresh / model catalog edits)
   *  hide for everyone else. The server enforces the same rule. */
  viewer_is_owner: boolean;
  per_user_rpm: number | null;
  per_user_rpd: number | null;
  per_user_tpd: number | null;
  global_rpm: number | null;
  global_rpd: number | null;
  global_tpd: number | null;
};

type ProviderModel = {
  id: number;
  provider_id: string;
  upstream_id: string;
  display_name: string;
  enabled: boolean;
  owned_by: string | null;
};

function headersToText(h: Record<string, string> | null): string {
  return h ? JSON.stringify(h, null, 2) : "";
}

/** Parse the optional extra-headers JSON box. "" → null; bad JSON throws. */
function parseHeaders(text: string): Record<string, string> | null {
  const t = text.trim();
  if (!t) return null;
  const o = JSON.parse(t);
  if (!o || typeof o !== "object" || Array.isArray(o))
    throw new Error("must be a JSON object");
  return o as Record<string, string>;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Add-provider modal ────────────────────────────────────────────────

function AddProviderModal({
  existingPrefixes,
  onClose,
  onCreated,
}: {
  existingPrefixes: Set<string>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState("");
  // Default owner = the admin doing the add. Pulled from /api/admin/me on
  // mount so we don't have to re-type our own Discord id every time, and so
  // a freshly-created provider always has an editable owner. Still editable
  // in case ownership should land on a different admin from the start.
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState<"idle" | "testing" | "saving">("idle");
  const [probed, setProbed] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { ok, data } = await api("/api/admin/me", "GET");
      if (!cancelled && ok && typeof data?.discordId === "string")
        setOwnerId(data.discordId);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "Test" is now REQUIRED before Add. Any change to a field that
  // affects whether we can reach the provider (URL, key, headers)
  // clears the previous test result so a stale "Works! 47 models" can't
  // trick the admin into saving against credentials we never actually
  // checked. Name / prefix / owner don't affect the test, so editing
  // them after a successful test is fine.
  useEffect(() => {
    setProbed(null);
  }, [baseUrl, apiKey, headers]);

  const prefixClash =
    prefix.length > 0 && existingPrefixes.has(prefix.toLowerCase());
  const prefixValid = /^[a-z0-9]{2,4}$/.test(prefix);
  const validated = probed !== null;

  const buildBody = () => {
    let extra_headers: Record<string, string> | null = null;
    try {
      extra_headers = parseHeaders(headers);
    } catch (e) {
      toast.error(`Extra headers: ${(e as Error).message}`);
      return null;
    }
    return {
      display_name: displayName.trim(),
      prefix: prefix.trim().toLowerCase(),
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(),
      extra_headers,
      owner_id: ownerId.trim() || undefined,
    };
  };

  const validate = async () => {
    const body = buildBody();
    if (!body) return;
    setBusy("testing");
    setProbed(null);
    try {
      const { ok, data } = await api(
        "/api/admin/providers/validate",
        "POST",
        body,
      );
      if (ok) {
        setProbed(data.model_count ?? 0);
        toast.success(`Works! Found ${data.model_count ?? 0} models.`);
      } else {
        toast.error(
          data.error ?? "Couldn't connect — check your URL and key.",
        );
      }
    } finally {
      setBusy("idle");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return toast.error("Display name is required");
    if (!prefixValid)
      return toast.error("Prefix must be 2–4 lowercase letters/digits");
    if (prefixClash) return toast.error("That prefix is already in use");
    // Belt-and-suspenders. The Add button is disabled in the UI when
    // !validated, but a determined user can re-enable it in devtools —
    // so we re-check here. The server also re-probes inside the create
    // endpoint, so this isn't a security gate, just a UX guardrail
    // against saving against unchecked credentials.
    if (!validated)
      return toast.error("Click Test first so we can check it works.");
    const body = buildBody();
    if (!body) return;
    setBusy("saving");
    try {
      const { ok, data } = await api("/api/admin/providers", "POST", body);
      if (ok) {
        toast.success(
          `Added "${displayName}" — ${data.model_count ?? 0} models imported`,
        );
        onCreated();
        onClose();
      } else {
        toast.error(data.error ?? "Create failed");
      }
    } finally {
      setBusy("idle");
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border-2 border-primary rounded-2xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-xl text-primary">Add provider</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Fill in the boxes, click <strong>Test</strong>, then{" "}
          <strong>Add provider</strong>.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Display name *</label>
            <input
              className={inputCls}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Groq"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Prefix *</label>
            <input
              className={`${inputCls} font-mono ${
                prefix && (!prefixValid || prefixClash)
                  ? "!border-destructive"
                  : ""
              }`}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toLowerCase())}
              placeholder="2–4 chars, e.g. gr"
              maxLength={4}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Users type <code>{prefix || "gr"}/model-name</code>.{" "}
              {prefix && !prefixValid && (
                <span className="text-destructive">
                  Must be 2–4 lowercase letters/digits.
                </span>
              )}
              {prefixClash && (
                <span className="text-destructive">Already in use.</span>
              )}
            </p>
          </div>
          <div>
            <label className="block text-sm mb-1">Base URL *</label>
            <input
              className={inputCls + " font-mono text-sm"}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">API key *</label>
            <input
              className={inputCls + " font-mono text-sm"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="sk-…"
            />
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground select-none">
              Extra headers (optional)
            </summary>
            <textarea
              className={inputCls + " font-mono text-xs mt-2"}
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={'{ "HTTP-Referer": "https://app.crimsons-proxy.workers.dev" }'}
            />
            <p className="text-xs text-muted-foreground mt-1">
              JSON object, sent on every upstream call (e.g. OpenRouter
              ranking headers).
            </p>
          </details>
          <div>
            <label className="block text-sm mb-1">
              Owner — Discord user ID (optional)
            </label>
            <input
              className={inputCls + " font-mono text-sm"}
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              placeholder="e.g. 1492228386532229353"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Only the owner can edit this later. Leave blank to let any
              admin edit it.
            </p>
          </div>
          {validated && (
            <div className="text-sm text-green-500 flex items-center gap-2">
              <Check className="w-4 h-4" /> Works! Found {probed} models.
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className={btnPrimary}
              disabled={busy !== "idle" || !validated}
              title={
                !validated
                  ? "Click Test first so we can check your URL and key work."
                  : undefined
              }
            >
              <Save className="w-4 h-4" />
              {busy === "saving" ? "Adding…" : "Add provider"}
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={validate}
              disabled={busy !== "idle"}
            >
              {busy === "testing" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Server className="w-4 h-4" />
              )}
              Test
            </button>
            <button type="button" className={btnGhost} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Per-provider model catalog (mask / enable; no add, no delete) ────
//
// All edits — including the per-row Save — require ownership. Non-owner
// admins see the catalog read-only (inputs disabled, no Save button) so
// they can audit what's exposed without being able to modify it. Adding
// or removing models is intentionally NOT supported here: the catalog
// reflects the upstream `/v1/models`, refreshed via the parent provider
// card. The server enforces the same rules — this UI is just a hint.

function ModelCatalog({
  providerId,
  isOwner,
}: {
  providerId: string;
  isOwner: boolean;
}) {
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = async () => {
    const { ok, data } = await api(
      `/api/admin/providers/${providerId}/models`,
      "GET",
    );
    if (ok) setModels(data.models ?? []);
    else toast.error(data.error ?? "Failed to load models");
  };
  useEffect(() => {
    load();
  }, [providerId]);

  if (!models)
    return (
      <div className="text-muted-foreground text-sm py-4 px-4">Loading…</div>
    );

  const setLocal = (id: number, patch: Partial<ProviderModel>) =>
    setModels((ms) =>
      (ms ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );

  const saveModel = async (m: ProviderModel) => {
    setSavingId(m.id);
    try {
      const { ok, data } = await api(
        `/api/admin/provider-models/${m.id}`,
        "PATCH",
        { display_name: m.display_name, enabled: m.enabled },
      );
      if (ok) toast.success(`Saved "${m.display_name}"`);
      else {
        toast.error(data.error ?? "Save failed");
        load();
      }
    } finally {
      setSavingId(null);
    }
  };

  const shown = models.filter(
    (m) =>
      !filter ||
      m.display_name.toLowerCase().includes(filter.toLowerCase()) ||
      m.upstream_id.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="bg-muted/40 border-t-2 border-border px-4 py-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground">
          {isOwner ? (
            <>
              <strong>Mask</strong> renames a model (what users type after the
              prefix). Disable to hide it. Names must be unique within this
              provider. To add or remove rows, use Refresh models — the catalog
              tracks what the upstream serves.
            </>
          ) : (
            <>Read-only — only the provider's owner can edit this catalog.</>
          )}
        </p>
        <input
          className={numCls + " !w-40"}
          placeholder="filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-background sticky top-0">
            <tr>
              <th className="text-left p-2 font-medium">Display name (mask)</th>
              <th className="text-left p-2 font-medium">Upstream id</th>
              <th className="text-center p-2 font-medium w-16">On</th>
              {isOwner && <th className="p-2 w-16" />}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td
                  colSpan={isOwner ? 4 : 3}
                  className="p-4 text-center text-muted-foreground"
                >
                  {models.length === 0
                    ? "No models. Owner: use Refresh models on the parent provider."
                    : "No matches."}
                </td>
              </tr>
            ) : (
              shown.map((m) => (
                <tr key={m.id} className="border-t border-border">
                  <td className="p-2">
                    <input
                      className={numCls + " !w-52"}
                      value={m.display_name}
                      disabled={!isOwner}
                      onChange={(e) =>
                        setLocal(m.id, { display_name: e.target.value })
                      }
                    />
                  </td>
                  <td className="p-2 font-mono text-xs text-muted-foreground break-all">
                    {m.upstream_id}
                  </td>
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      disabled={!isOwner}
                      onChange={(e) =>
                        setLocal(m.id, { enabled: e.target.checked })
                      }
                    />
                  </td>
                  {isOwner && (
                    <td className="p-2">
                      <div className="flex justify-end">
                        <button
                          title="Save"
                          className="p-1.5 hover:bg-accent rounded text-primary disabled:opacity-50"
                          disabled={savingId === m.id}
                          onClick={() => saveModel(m)}
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── One provider card ─────────────────────────────────────────────────

function ProviderCard({
  initial,
  onChanged,
}: {
  initial: Provider;
  onChanged: () => void;
}) {
  const [p, setP] = useState<Provider>(initial);
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState(headersToText(initial.extra_headers));
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showModels, setShowModels] = useState(false);
  // Live progress while the per-model probe loop is running. null when
  // idle; set as soon as the first probe fires so the operator sees
  // a counter instead of a frozen "Testing…" label.
  const [testProgress, setTestProgress] = useState<{
    done: number;
    total: number;
    works: number;
    broken: number;
    rateLimited: number;
    current?: string;
    waitingUntil?: number; // ms-epoch — non-null while backing off after a 429
  } | null>(null);
  // Sentinel the test loop reads each iteration so the "Stop" button
  // can short-circuit the loop without ripping the in-flight fetch.
  const cancelRef = useRef(false);
  // Built-ins (tm, mock) have no human owner, so any admin can still
  // toggle their non-cred fields (display name, enabled, limits) — the
  // server enforces this. canEdit lets the UI hide cred-only sections
  // for non-owners on dynamic providers without blocking those builtins.
  const isOwner = p.viewer_is_owner;
  const builtin = p.kind === "builtin";
  const canEdit = builtin || isOwner;
  useEffect(() => {
    setP(initial);
    setHeaders(headersToText(initial.extra_headers));
  }, [initial]);

  const set = (patch: Partial<Provider>) => setP({ ...p, ...patch });
  const num = (k: keyof Provider, label: string) => (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      <input
        className={numCls}
        inputMode="numeric"
        placeholder="—"
        disabled={!canEdit}
        value={numStr(p[k] as number | null)}
        onChange={(e) =>
          set({
            [k]: e.target.value === "" ? null : Number(e.target.value),
          } as Partial<Provider>)
        }
      />
    </div>
  );

  const save = async () => {
    const body: Record<string, unknown> = {
      display_name: p.display_name,
      enabled: p.enabled,
      visible: p.visible,
      // "" clears the owner; backend validates it's a Discord id otherwise.
      owner_id: p.owner_id ?? "",
      per_user_rpm: p.per_user_rpm,
      per_user_rpd: p.per_user_rpd,
      per_user_tpd: p.per_user_tpd,
      global_rpm: p.global_rpm,
      global_rpd: p.global_rpd,
      global_tpd: p.global_tpd,
    };
    if (!builtin) {
      body.prefix = p.prefix;
      body.base_url = p.base_url;
      if (apiKey.trim()) body.api_key = apiKey.trim();
      try {
        body.extra_headers = parseHeaders(headers);
      } catch (e) {
        return toast.error(`Extra headers: ${(e as Error).message}`);
      }
    }
    setSaving(true);
    try {
      const { ok, data } = await api(
        `/api/admin/providers/${p.id}`,
        "PATCH",
        body,
      );
      if (ok) {
        toast.success(`Saved "${p.display_name}"`);
        setApiKey("");
        onChanged();
      } else toast.error(data.error ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { ok, data } = await api(
        `/api/admin/providers/${p.id}/refresh-models`,
        "POST",
      );
      if (ok) {
        toast.success(
          `Refreshed: +${data.added} new, ${data.disabled} gone, ${data.upstream_total} total`,
        );
        onChanged();
      } else toast.error(data.error ?? "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  // "Test & disable faulty" — drive the per-model probe endpoint from
  // the browser, one model at a time. Two reasons we do this here and
  // not server-side:
  //   1. A bulk runner against a rate-limiting upstream cascades 429s
  //      and false-negatives most of the catalog (we measured 302/406
  //      models on cre/ disabled purely from rate-limit pressure during
  //      the first attempt). Per-request pacing avoids that.
  //   2. Vercel's function ceiling is 5 minutes; orchestrating in the
  //      browser removes that cap entirely.
  //
  // Retry policy per model:
  //   - Probe once
  //   - On HTTP 429 (rate limited): wait 10s, 20s, 30s between retries
  //     (4 attempts total)
  //   - If the 4th attempt still 429s: PATCH the row to enabled=false
  //     and move on. Better to err on the side of disabling than to
  //     leave a model the user can never get past the upstream's
  //     gatekeeper.
  //   - Any conclusive result (works or non-429 broken) ends the retry
  //     chain immediately. The server endpoint flips enabled itself.
  const testModels = async () => {
    if (
      !confirm(
        "This will send a tiny test request to every model on this " +
        "provider. Working models get enabled, broken ones get disabled. " +
        "Rate-limited models are retried 3 times (10s, 20s, 30s) before " +
        "being disabled. Can take a while on big providers. Continue?",
      )
    )
      return;

    // Pull the current catalog so we know exactly which rows to probe.
    const list = await api(`/api/admin/providers/${p.id}/models`, "GET");
    if (!list.ok) {
      toast.error(list.data.error ?? "Couldn't load model list");
      return;
    }
    const models = (list.data.models ?? []) as ProviderModel[];
    if (models.length === 0) {
      toast.info("No models on this provider yet.");
      return;
    }

    cancelRef.current = false;
    setTesting(true);
    setTestProgress({
      done: 0,
      total: models.length,
      works: 0,
      broken: 0,
      rateLimited: 0,
    });

    const BACKOFFS_MS = [10_000, 20_000, 30_000];
    let works = 0;
    let broken = 0;
    let rateLimitedOut = 0;
    let serverErrors = 0;

    for (let i = 0; i < models.length; i++) {
      if (cancelRef.current) break;

      const m = models[i];
      setTestProgress({
        done: i,
        total: models.length,
        works,
        broken,
        rateLimited: rateLimitedOut,
        current: m.display_name,
      });

      let finalOutcome: "works" | "broken" | "rate-limited-out" = "broken";

      for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
        if (cancelRef.current) break;
        const probe = await api(
          `/api/admin/providers/${p.id}/probe-model`,
          "POST",
          { model_id: m.id },
        );
        if (!probe.ok) {
          // Server-side error (auth lost, network blip, etc). Don't keep
          // hammering — bail this model's loop, count it under broken.
          serverErrors++;
          finalOutcome = "broken";
          break;
        }
        const outcome = probe.data.outcome as
          | "works"
          | "broken"
          | "transient";
        if (outcome === "transient") {
          if (attempt < BACKOFFS_MS.length) {
            // Wait the prescribed backoff, then retry the SAME model.
            const waitMs = BACKOFFS_MS[attempt];
            const until = Date.now() + waitMs;
            setTestProgress({
              done: i,
              total: models.length,
              works,
              broken,
              rateLimited: rateLimitedOut,
              current: m.display_name,
              waitingUntil: until,
            });
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          // Exhausted retries — still 429. Force the disable via the
          // model PATCH endpoint (the probe endpoint deliberately
          // leaves rows alone on 429).
          await api(`/api/admin/provider-models/${m.id}`, "PATCH", {
            enabled: false,
          });
          finalOutcome = "rate-limited-out";
          break;
        }
        finalOutcome = outcome;
        break;
      }

      if (finalOutcome === "works") works++;
      else if (finalOutcome === "broken") broken++;
      else rateLimitedOut++;
    }

    const stopped = cancelRef.current;
    setTesting(false);
    setTestProgress(null);
    cancelRef.current = false;

    const headline = stopped
      ? `Stopped — checked ${works + broken + rateLimitedOut}/${models.length}.`
      : `Done — checked ${models.length}.`;
    const suffix =
      ` ${works} working, ${broken} broken, ${rateLimitedOut} disabled after 4× rate-limit` +
      (serverErrors > 0 ? `, ${serverErrors} server errors` : "");
    toast.success(headline + suffix);
    onChanged();
  };

  const stopTesting = () => {
    cancelRef.current = true;
  };

  // NOTE: provider delete intentionally not exposed in the UI — the
  // server endpoint is gone too. Disable instead. See server route.

  return (
    <div className="bg-card border-2 border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-xs px-2 py-1 rounded bg-muted">
            {p.prefix}/
          </code>
          <input
            className={inputCls + " !w-48"}
            value={p.display_name}
            disabled={!canEdit}
            onChange={(e) => set({ display_name: e.target.value })}
          />
          {builtin ? (
            <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-800">
              built-in
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-800">
              {p.model_enabled_count}/{p.model_count} models
            </span>
          )}
          <label className="flex items-center gap-2 text-sm ml-1">
            <input
              type="checkbox"
              checked={p.enabled}
              disabled={!canEdit}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          {/* Visible only matters when enabled: an enabled-but-unticked
              provider is callable but hidden from the models list and the
              status board. Greyed out when the provider is disabled. */}
          <label
            className="flex items-center gap-2 text-sm ml-1"
            title="Callable but hidden from the models list and status board. Only applies when Enabled."
          >
            <input
              type="checkbox"
              checked={p.visible}
              disabled={!canEdit || !p.enabled}
              onChange={(e) => set({ visible: e.target.checked })}
            />
            Visible
          </label>
          {/* Read-only badge for non-owner admins so they understand why
              inputs are greyed out. Built-ins skip this — every admin
              can still tune their non-cred fields. */}
          {!builtin && !isOwner && (
            <span className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground">
              read-only
            </span>
          )}
          {/* Owner attribution — admin-only, never shown to end users. */}
          {p.owner ? (
            <span
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-muted"
              title={`Owner: ${p.owner.username} (${p.owner.id})`}
            >
              {p.owner.avatar ? (
                <img
                  src={`https://cdn.discordapp.com/avatars/${p.owner.id}/${p.owner.avatar}.png?size=32`}
                  alt=""
                  className="w-4 h-4 rounded-full"
                />
              ) : (
                <span className="w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center text-[9px] font-medium text-primary">
                  {p.owner.username.charAt(0).toUpperCase()}
                </span>
              )}
              {p.owner.username}
            </span>
          ) : p.owner_id ? (
            <span
              className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground"
              title={`Owner id ${p.owner_id} (profile not resolved)`}
            >
              owner: {p.owner_id}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* Refresh + Save are owner-only on dynamic providers; built-ins
              keep Save (any admin can adjust their non-cred fields, the
              server enforces no cred touches). No delete button — by
              design, see comment above. */}
          {!builtin && isOwner && (
            <>
              <button
                className={btnGhost}
                onClick={refresh}
                disabled={refreshing || testing}
                title={`Last synced ${timeAgo(p.models_synced_at)}`}
              >
                <RefreshCw
                  className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
                />
                Refresh models
              </button>
              {testing ? (
                <button
                  className={btnGhost}
                  onClick={stopTesting}
                  title="Stop the test loop at the next model boundary."
                >
                  <X className="w-4 h-4" />
                  Stop
                </button>
              ) : (
                <button
                  className={btnGhost}
                  onClick={testModels}
                  disabled={refreshing}
                  title="Send a small test request to every model and disable the ones that don't respond. Rate-limited models are retried 3 times (10s/20s/30s) before being disabled."
                >
                  <Stethoscope className="w-4 h-4" />
                  Test &amp; disable faulty
                </button>
              )}
            </>
          )}
          {canEdit && (
            <button className={btnPrimary} onClick={save} disabled={saving}>
              <Save className="w-4 h-4" />
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          {/* Provider delete button intentionally removed — disable via
              the Enabled checkbox instead. The DELETE endpoint is gone
              too; no destructive ops in the panel. */}
        </div>
      </div>

      {/* Live test-loop status line — appears only while a probe loop is
          in flight, so the operator can see how far through the catalog
          we are without having to crack open the dev console. */}
      {testProgress && (
        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs flex items-center gap-3 flex-wrap">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          <span className="font-mono">
            {testProgress.done}/{testProgress.total}
          </span>
          {testProgress.current && (
            <span className="text-muted-foreground truncate max-w-xs">
              {testProgress.waitingUntil
                ? `waiting (rate-limited) on `
                : `probing `}
              <code>{testProgress.current}</code>
            </span>
          )}
          <span className="text-green-600">✓ {testProgress.works}</span>
          <span className="text-destructive">✗ {testProgress.broken}</span>
          {testProgress.rateLimited > 0 && (
            <span className="text-amber-600">
              ⏳ {testProgress.rateLimited} disabled after retries
            </span>
          )}
        </div>
      )}

      {!builtin && isOwner && (
        // Owner-only block. Non-owner admins can't read base_url anyway
        // (server returns "" for them) and can't edit any of these
        // fields, so we hide the whole section to keep the card tidy.
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Prefix
            </label>
            <input
              className={numCls + " !w-24 font-mono"}
              value={p.prefix}
              maxLength={4}
              onChange={(e) =>
                set({ prefix: e.target.value.toLowerCase() })
              }
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Base URL
            </label>
            <input
              className={inputCls + " font-mono text-xs"}
              value={p.base_url}
              onChange={(e) => set({ base_url: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              API key {p.has_api_key && "(set — blank keeps current)"}
            </label>
            <input
              className={inputCls + " font-mono text-xs"}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={p.has_api_key ? "•••••••• (unchanged)" : "sk-…"}
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Extra headers (JSON)
            </label>
            <input
              className={inputCls + " font-mono text-xs"}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder="{ }"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Owner — Discord user ID (admin-only, never shown to users)
            </label>
            <input
              className={inputCls + " font-mono text-xs"}
              value={p.owner_id ?? ""}
              onChange={(e) => set({ owner_id: e.target.value || null })}
              placeholder="e.g. 1492228386532229353 — blank to clear"
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {num("per_user_rpm", "per-user RPM")}
        {num("per_user_rpd", "per-user RPD")}
        {num("per_user_tpd", "per-user TPD")}
        <div className="w-px bg-border" />
        {num("global_rpm", "global RPM")}
        {num("global_rpd", "global RPD")}
        {num("global_tpd", "global TPD")}
      </div>

      {!builtin && (
        <div className="rounded-lg border border-border overflow-hidden">
          <button
            className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-muted/60"
            onClick={() => setShowModels((v) => !v)}
          >
            {showModels ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Model catalog ({p.model_enabled_count} enabled / {p.model_count})
          </button>
          {showModels && <ModelCatalog providerId={p.id} isOwner={isOwner} />}
        </div>
      )}
    </div>
  );
}

function ProvidersPanel() {
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Mock is a code-only test provider — never shown here.
  const HIDDEN_PROVIDERS: ReadonlySet<string> = new Set(["mock"]);

  const load = async () => {
    const { ok, data } = await api("/api/admin/providers", "GET");
    if (ok) setRows(data.providers ?? []);
    else toast.error(data.error ?? "Failed to load providers");
  };
  useEffect(() => {
    load();
  }, []);

  if (!rows) {
    return (
      <div className="text-muted-foreground py-10 text-center">Loading…</div>
    );
  }

  const visible = rows.filter((p) => !HIDDEN_PROVIDERS.has(p.id));
  const prefixes = new Set(rows.map((r) => r.prefix?.toLowerCase()).filter(Boolean));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Add any OpenAI-compatible API. Users type{" "}
          <code>prefix/model-name</code>. Blank limit = not enforced;{" "}
          <span className="font-medium">per-user</span> caps one user,{" "}
          <span className="font-medium">global</span> caps everyone combined on
          that provider (gates 2 &amp; 3 on top of the overall budget).
        </p>
        <button className={btnPrimary} onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" />
          Add provider
        </button>
      </div>

      {visible.map((p) => (
        <ProviderCard key={p.id} initial={p} onChanged={load} />
      ))}

      {showAdd && (
        <AddProviderModal
          existingPrefixes={prefixes}
          onClose={() => setShowAdd(false)}
          onCreated={load}
        />
      )}
    </div>
  );
}

// ─── Tiers (+ per-provider overrides) ──────────────────────────────────

type Tier = {
  id: number;
  name: string;
  discord_role_id: string;
  priority: number;
  rpm: number | null;
  rpd: number | null;
  tpd: number | null;
};

type Override = {
  tier_id: number;
  provider_id: string;
  rpm: number | null;
  rpd: number | null;
  tpd: number | null;
};

function TierModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Tier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [roleId, setRoleId] = useState(initial?.discord_role_id ?? "");
  const [priority, setPriority] = useState(String(initial?.priority ?? 0));
  const [rpm, setRpm] = useState(numStr(initial?.rpm));
  const [rpd, setRpd] = useState(numStr(initial?.rpd));
  const [tpd, setTpd] = useState(numStr(initial?.tpd));
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !roleId.trim()) {
      toast.error("Name and Discord role ID are required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        discord_role_id: roleId.trim(),
        priority: priority === "" ? 0 : Number(priority),
        rpm: rpm === "" ? null : Number(rpm),
        rpd: rpd === "" ? null : Number(rpd),
        tpd: tpd === "" ? null : Number(tpd),
      };
      const { ok, data } = initial
        ? await api(`/api/admin/tiers/${initial.id}`, "PATCH", payload)
        : await api("/api/admin/tiers", "POST", payload);
      if (ok) {
        toast.success(initial ? "Tier updated" : "Tier created");
        onSaved();
        onClose();
      } else {
        toast.error(data.error ?? "Save failed");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border-2 border-primary rounded-2xl p-6 max-w-lg w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl text-primary">
            {initial ? `Edit tier — ${initial.name}` : "New tier"}
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Name *</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. VIP, Booster"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Discord Role ID *</label>
            <input
              className={inputCls + " font-mono"}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              placeholder="numeric role id"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Priority</label>
            <input
              className={numCls}
              inputMode="numeric"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Highest priority wins when a user has multiple tier roles.
            </p>
          </div>
          <div className="flex gap-3">
            <div>
              <label className="block text-sm mb-1">RPM</label>
              <input className={numCls} inputMode="numeric" placeholder="global" value={rpm} onChange={(e) => setRpm(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm mb-1">RPD</label>
              <input className={numCls} inputMode="numeric" placeholder="global" value={rpd} onChange={(e) => setRpd(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm mb-1">TPD</label>
              <input className={numCls} inputMode="numeric" placeholder="global" value={tpd} onChange={(e) => setTpd(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Blank metric = fall back to the global default for that metric.
          </p>
          <div className="flex gap-2 pt-1">
            <button type="submit" className={btnPrimary} disabled={saving}>
              <Save className="w-4 h-4" />
              {saving ? "Saving…" : "Save tier"}
            </button>
            <button type="button" className={btnGhost} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function OverrideEditor({
  tier,
  providers,
  overrides,
  onChanged,
}: {
  tier: Tier;
  providers: Provider[];
  overrides: Override[];
  onChanged: () => void;
}) {
  // Local editable copy keyed by provider id.
  const initial: Record<string, { rpm: string; rpd: string; tpd: string }> = {};
  for (const p of providers) {
    const o = overrides.find(
      (x) => x.tier_id === tier.id && x.provider_id === p.id,
    );
    initial[p.id] = {
      rpm: numStr(o?.rpm),
      rpd: numStr(o?.rpd),
      tpd: numStr(o?.tpd),
    };
  }
  const [vals, setVals] = useState(initial);
  const [savingP, setSavingP] = useState<string | null>(null);

  const save = async (providerId: string) => {
    setSavingP(providerId);
    try {
      const v = vals[providerId];
      const { ok, data } = await api(
        "/api/admin/tier-provider-limits",
        "PUT",
        {
          tier_id: tier.id,
          provider_id: providerId,
          rpm: v.rpm === "" ? null : Number(v.rpm),
          rpd: v.rpd === "" ? null : Number(v.rpd),
          tpd: v.tpd === "" ? null : Number(v.tpd),
        },
      );
      if (ok) {
        toast.success(`Override saved (${tier.name} · ${providerId})`);
        onChanged();
      } else {
        toast.error(data.error ?? "Save failed");
      }
    } finally {
      setSavingP(null);
    }
  };

  return (
    <div className="bg-muted/40 border-t-2 border-border px-4 py-4">
      <p className="text-xs text-muted-foreground mb-3">
        Per-provider override for <strong>{tier.name}</strong>. Set a metric to
        override this tier's value on that provider; clear all three to remove
        the override (falls back to the provider's per-user default).
      </p>
      <div className="space-y-2">
        {providers.map((p) => (
          <div key={p.id} className="flex items-center gap-3 flex-wrap">
            <code className="text-xs px-2 py-1 rounded bg-background w-28">
              {p.id}
            </code>
            {(["rpm", "rpd", "tpd"] as const).map((m) => (
              <input
                key={m}
                className={numCls}
                inputMode="numeric"
                placeholder={m.toUpperCase()}
                value={vals[p.id][m]}
                onChange={(e) =>
                  setVals({
                    ...vals,
                    [p.id]: { ...vals[p.id], [m]: e.target.value },
                  })
                }
              />
            ))}
            <button
              className={btnGhost + " !py-1.5"}
              disabled={savingP === p.id}
              onClick={() => save(p.id)}
            >
              <Save className="w-3.5 h-3.5" />
              {savingP === p.id ? "…" : "Save"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TiersPanel() {
  const [tiers, setTiers] = useState<Tier[] | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [modal, setModal] = useState<{ open: boolean; tier: Tier | null }>({
    open: false,
    tier: null,
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = async () => {
    const [t, p, o] = await Promise.all([
      api("/api/admin/tiers", "GET"),
      api("/api/admin/providers", "GET"),
      api("/api/admin/tier-provider-limits", "GET"),
    ]);
    if (t.ok) setTiers(t.data.tiers ?? []);
    else toast.error(t.data.error ?? "Failed to load tiers");
    if (p.ok) setProviders(p.data.providers ?? []);
    if (o.ok) setOverrides(o.data.overrides ?? []);
  };
  useEffect(() => {
    load();
  }, []);

  if (!tiers) {
    return <div className="text-muted-foreground py-10 text-center">Loading…</div>;
  }

  const del = async (t: Tier) => {
    if (!confirm(`Delete tier "${t.name}"? Its provider overrides go too.`))
      return;
    const { ok, data } = await api(`/api/admin/tiers/${t.id}`, "DELETE");
    if (ok) {
      toast.success(`Deleted "${t.name}"`);
      load();
    } else {
      toast.error(data.error ?? "Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          A user's tier = highest-priority tier whose Discord role they have.
          Overrides the global per-user budget.
        </p>
        <button
          className={btnPrimary}
          onClick={() => setModal({ open: true, tier: null })}
        >
          <Plus className="w-4 h-4" />
          New tier
        </button>
      </div>

      {tiers.length === 0 ? (
        <div className="text-center text-muted-foreground py-10 bg-card border-2 border-border rounded-xl">
          No tiers yet. Everyone gets the global default budget.
        </div>
      ) : (
        <div className="bg-card border-2 border-border rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-muted text-sm">
              <tr>
                <th className="text-left p-3 w-8" />
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Role ID</th>
                <th className="text-right p-3">Priority</th>
                <th className="text-right p-3">RPM</th>
                <th className="text-right p-3">RPD</th>
                <th className="text-right p-3">TPD</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <Fragment key={t.id}>
                  <tr className="border-t border-border">
                    <td className="p-3">
                      <button
                        onClick={() =>
                          setExpanded(expanded === t.id ? null : t.id)
                        }
                        title="Per-provider overrides"
                        className="hover:text-primary"
                      >
                        {expanded === t.id ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>
                    </td>
                    <td className="p-3">{t.name}</td>
                    <td className="p-3 font-mono text-xs text-muted-foreground">
                      {t.discord_role_id}
                    </td>
                    <td className="p-3 text-right">{t.priority}</td>
                    <td className="p-3 text-right">{t.rpm ?? "—"}</td>
                    <td className="p-3 text-right">{t.rpd ?? "—"}</td>
                    <td className="p-3 text-right">{t.tpd ?? "—"}</td>
                    <td className="p-3">
                      <div className="flex justify-end gap-1">
                        <button
                          title="Edit"
                          onClick={() => setModal({ open: true, tier: t })}
                          className="p-1.5 hover:bg-accent rounded text-primary"
                        >
                          <SlidersHorizontal className="w-4 h-4" />
                        </button>
                        <button
                          title="Delete"
                          onClick={() => del(t)}
                          className="p-1.5 hover:bg-destructive/10 rounded text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded === t.id && (
                    <tr key={`${t.id}-ov`}>
                      <td colSpan={8} className="p-0">
                        <OverrideEditor
                          tier={t}
                          providers={providers}
                          overrides={overrides}
                          onChanged={load}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal.open && (
        <TierModal
          initial={modal.tier}
          onClose={() => setModal({ open: false, tier: null })}
          onSaved={load}
        />
      )}
    </div>
  );
}

// ─── Shell ─────────────────────────────────────────────────────────────

export function LimitsConfig() {
  const [tab, setTab] = useState<"global" | "tiers" | "providers">("global");

  const tabs = [
    { id: "global" as const, label: "Global", icon: SlidersHorizontal },
    { id: "tiers" as const, label: "Tiers", icon: Layers },
    { id: "providers" as const, label: "Providers", icon: Server },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex border-b-2 border-border gap-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`pb-3 font-medium text-sm transition-colors border-b-2 -mb-0.5 flex items-center gap-2 ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "global" && <GlobalPanel />}
      {tab === "tiers" && <TiersPanel />}
      {tab === "providers" && <ProvidersPanel />}
    </div>
  );
}
