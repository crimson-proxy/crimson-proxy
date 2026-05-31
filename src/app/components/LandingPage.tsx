import { useEffect, useMemo, useState } from "react";
import { Cat, Sparkles, Loader2, Check, Copy } from "lucide-react";
import { groupForUi, prefixOf, type Model } from "../lib/grouping";

type ProviderOwner = {
  prefix: string;
  owner: { id: string; username: string; avatar: string | null } | null;
};

export function LandingPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [owners, setOwners] = useState<ProviderOwner[]>([]);
  const [loading, setLoading] = useState(true);
  // Tracks which model card was most recently copied so we can flip its
  // icon to a checkmark for ~1.2s. Keyed by model.id (the internal id,
  // unique even when two providers happen to expose the same name).
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyModelName(model: Model) {
    try {
      // The bare `name` is what users actually paste into their client
      // (e.g. "deepseek/deepseek-v4-pro"), so that's what we copy —
      // never `model.id`, which may carry an internal prefix.
      await navigator.clipboard.writeText(model.name);
      setCopiedId(model.id);
      // Auto-clear so the indicator doesn't stick around forever.
      window.setTimeout(() => {
        setCopiedId((current) => (current === model.id ? null : current));
      }, 1200);
    } catch {
      // Clipboard can fail (insecure context, permissions). Silent
      // failure is fine — user will notice nothing was copied and can
      // select manually as a fallback.
    }
  }

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then(
        (data: {
          models: Model[];
          total: number;
          providers?: ProviderOwner[];
        }) => {
          setModels(data.models);
          setOwners(data.providers ?? []);
        },
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Premium section pulls all Claude models across providers, then
  // every prefix gets its own section below. Each Claude model also
  // appears in its prefix section — intentional, so users hunting by
  // prefix still see them. See src/app/lib/grouping.ts for the rule.
  const { premium, byPrefix } = useMemo(() => groupForUi(models), [models]);

  // prefix → owner lookup. Each prefix section uses it for its header
  // chip; the Premium section uses it per-card (since Claude models
  // come from many different providers, no one owner applies).
  const ownerByPrefix = useMemo(() => {
    const map = new Map<string, ProviderOwner["owner"]>();
    for (const p of owners) map.set(p.prefix, p.owner);
    return map;
  }, [owners]);

  return (
    <div className="relative min-h-screen overflow-hidden p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 120% at 15% 20%, rgba(139, 21, 56, 0.18), transparent 60%), radial-gradient(120% 120% at 85% 15%, rgba(202, 71, 113, 0.12), transparent 58%), linear-gradient(180deg, rgba(39, 11, 20, 0.96) 0%, rgba(26, 10, 15, 1) 100%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.08] mix-blend-soft-light"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255, 255, 255, 0.18) 0.5px, transparent 0.5px)",
            backgroundSize: "3px 3px",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.045] mix-blend-luminosity"
          style={{
            backgroundImage: "url('/og-cover.jpg')",
            backgroundPosition: "center",
            backgroundSize: "cover",
            filter: "grayscale(1) saturate(0.25)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at center, transparent 32%, rgba(14, 4, 8, 0.78) 100%)",
          }}
        />
        <div className="animate-float-slow absolute left-12 top-16 text-5xl opacity-10">🐱</div>
        <div className="animate-float-slower absolute right-12 top-20 text-4xl opacity-10">🌸</div>
        <div className="animate-float-slow absolute bottom-16 left-20 text-4xl opacity-10">🌺</div>
        <div className="animate-float-slower absolute bottom-10 right-16 text-5xl opacity-10">🏵️</div>
      </div>

      <div className="relative z-10 mx-auto max-w-5xl">
        <header className="animate-fade-up mb-12 pt-8 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Cat className="w-12 h-12 text-primary" />
            <h1 className="text-primary text-4xl font-bold">Crimson's Proxy</h1>
            <Cat className="w-12 h-12 text-primary" />
          </div>
          <p className="text-muted-foreground text-lg mb-2">
            Free AI Proxy — OpenAI-compatible API for Janitor AI
          </p>
          <p className="text-muted-foreground text-sm mb-6">
            Access premium AI models at no cost. Just join, verify, and start chatting.
          </p>
          <a
            href="/login"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-8 py-3 text-lg text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-[0_8px_28px_rgba(139,21,56,0.35)]"
          >
            <Cat className="w-5 h-5" />
            Login with Discord
          </a>
        </header>

        <div className="mb-8 grid gap-4 sm:grid-cols-2">
          <div
            className="animate-fade-up rounded-xl border border-border bg-card/80 p-4 text-center backdrop-blur-sm"
            style={{ animationDelay: "120ms" }}
          >
            <p className="text-2xl font-bold text-primary">{models.length}</p>
            <p className="text-sm text-muted-foreground">Available Models</p>
          </div>
          <div
            className="animate-fade-up rounded-xl border border-border bg-card/80 p-4 text-center backdrop-blur-sm"
            style={{ animationDelay: "200ms" }}
          >
            <p className="text-2xl font-bold text-primary">Free</p>
            <p className="text-sm text-muted-foreground">For Verified Users</p>
          </div>
        </div>

        <div
          className="animate-fade-up rounded-2xl border-2 border-primary/80 bg-card/90 p-6 backdrop-blur-sm"
          style={{ animationDelay: "260ms" }}
        >
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-primary text-xl font-semibold">Available Models</h2>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
            </div>
          ) : models.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No models available. Check back later.
            </p>
          ) : (
            <div className="space-y-6">
              {/* Premium section: every Claude model across providers,
                  surfaced first with the amber-glow treatment. Renders
                  only if at least one Claude model exists in the
                  catalog — otherwise the whole section is omitted. */}
              {premium.length > 0 && (
                <ProviderSection
                  variant="premium"
                  label="Premium"
                  models={premium}
                  copiedId={copiedId}
                  onCopy={copyModelName}
                  delay={320}
                  ownerByPrefix={ownerByPrefix}
                />
              )}
              {/* Per-prefix sections, alphabetical. Header is the
                  routing prefix in uppercase (PN, VX, TM) — same
                  string users type in `model: pn/foo`, never the
                  internal provider name (AI.md rule 6). */}
              {byPrefix.map(([prefix, providerModels], index) => (
                <ProviderSection
                  key={prefix}
                  variant="standard"
                  label={prefix.toUpperCase()}
                  models={providerModels}
                  copiedId={copiedId}
                  onCopy={copyModelName}
                  delay={
                    320 + (premium.length > 0 ? 80 : 0) + index * 80
                  }
                  sectionOwner={ownerByPrefix.get(prefix) ?? null}
                  ownerByPrefix={ownerByPrefix}
                />
              ))}
            </div>
          )}
        </div>

        <footer
          className="animate-fade-up mt-12 text-center text-sm text-muted-foreground"
          style={{ animationDelay: "420ms" }}
        >
          <p>🐱 Made with love in a crimson cottage 🌸</p>
        </footer>
      </div>
    </div>
  );
}

// ─── Section components ───────────────────────────────────────────────────

type Owner = ProviderOwner["owner"];

interface ProviderSectionProps {
  variant: "premium" | "standard";
  label: string;
  models: Model[];
  copiedId: string | null;
  onCopy: (m: Model) => void;
  delay: number;
  /** Owner of this section's single provider. Null for premium (mixed
   *  providers) and for prefix sections with no owner_id set. */
  sectionOwner?: Owner;
  /** Used by the premium variant to render an owner chip per-card,
   *  since each Claude model can belong to a different provider. */
  ownerByPrefix?: Map<string, Owner>;
}

/**
 * One section on the landing page. `premium` variant renders the
 * amber-glow / pulsing-halo treatment that used to be reserved for
 * the Anthropic group; it's now anchored on the section's role
 * (premium = Claude across providers) rather than on a vendor
 * string. `standard` is the existing crimson treatment.
 */
function ProviderSection({
  variant,
  label,
  models,
  copiedId,
  onCopy,
  delay,
  sectionOwner,
  ownerByPrefix,
}: ProviderSectionProps) {
  const isPremium = variant === "premium";
  return (
    <section
      className={
        isPremium
          ? "animate-fade-up relative rounded-2xl border-2 border-amber-400/50 bg-gradient-to-br from-amber-500/[0.08] via-orange-500/[0.05] to-transparent p-4 shadow-[0_0_40px_rgba(251,191,36,0.18)]"
          : "animate-fade-up"
      }
      style={{ animationDelay: `${delay}ms` }}
    >
      {/* Animated halo behind the Premium section only. Pointer-events-
          none so it never blocks card clicks. */}
      {isPremium && (
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-2xl opacity-70 animate-anthropic-glow"
          style={{
            background:
              "radial-gradient(80% 60% at 50% 0%, rgba(251, 191, 36, 0.18), transparent 70%), radial-gradient(60% 60% at 100% 100%, rgba(244, 114, 22, 0.14), transparent 70%)",
          }}
        />
      )}
      <div className="relative">
        <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
          <h3
            className={
              isPremium
                ? "flex items-center gap-2 text-base font-bold text-amber-300 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)]"
                : "text-base font-semibold text-primary font-mono"
            }
          >
            {isPremium && (
              <Sparkles className="h-4 w-4 text-amber-300 animate-pulse" />
            )}
            {label}
            {isPremium && (
              <span className="ml-1 rounded-full border border-amber-400/60 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-200">
                ★ Premium
              </span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            {/* Standard sections all share one provider so the owner chip
                belongs here on the header. Premium is mixed-provider, so
                we render the chip per-card below instead. */}
            {!isPremium && sectionOwner && (
              <OwnerChip owner={sectionOwner} variant="header" />
            )}
            <span
              className={
                isPremium
                  ? "rounded-full border border-amber-400/60 bg-amber-400/15 px-3 py-1 text-xs font-semibold text-amber-200"
                  : "rounded-full border border-primary/35 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
              }
            >
              {models.length} model{models.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              isPremium={isPremium}
              isCopied={copiedId === model.id}
              onCopy={onCopy}
              badgeLabel={label}
              cardOwner={
                isPremium
                  ? ownerByPrefix?.get(prefixOf(model)) ?? null
                  : null
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}

interface ModelCardProps {
  model: Model;
  isPremium: boolean;
  isCopied: boolean;
  onCopy: (m: Model) => void;
  badgeLabel: string;
  /** Only set in the Premium section, where each card's provider can
   *  differ. Standard sections render the owner once in the header. */
  cardOwner: Owner;
}

function ModelCard({
  model,
  isPremium,
  isCopied,
  onCopy,
  badgeLabel,
  cardOwner,
}: ModelCardProps) {
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Copy model id ${model.name}`}
      onClick={() => onCopy(model)}
      onKeyDown={(event) => {
        // Keyboard parity with the click handler — Enter / Space
        // triggers the copy too, so the card is navigable without a
        // mouse.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onCopy(model);
        }
      }}
      className={
        isPremium
          ? "group relative cursor-pointer overflow-hidden rounded-xl border-2 border-amber-400/40 bg-gradient-to-br from-amber-500/[0.12] to-orange-600/[0.06] px-4 py-3 shadow-[0_0_20px_rgba(251,191,36,0.15)] transition-all duration-200 hover:-translate-y-1 hover:border-amber-300/80 hover:shadow-[0_12px_36px_rgba(251,191,36,0.45)] focus:outline-none focus:ring-2 focus:ring-amber-300/70"
          : "group cursor-pointer rounded-xl border border-border bg-input-background/85 px-4 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-[0_10px_30px_rgba(139,21,56,0.3)] focus:outline-none focus:ring-2 focus:ring-primary/60"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <p
          className={
            isPremium
              ? "text-sm font-bold leading-snug text-amber-100"
              : "text-sm font-semibold leading-snug text-card-foreground"
          }
        >
          {model.name}
        </p>
        <span
          className={
            isPremium
              ? "shrink-0 rounded-full border border-amber-400/60 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200"
              : "shrink-0 rounded-full border border-border bg-secondary/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground font-mono"
          }
        >
          {badgeLabel}
        </span>
      </div>
      {/* Bottom row of the card: copy affordance, plus (Premium only)
          the per-card owner chip — since the Premium section pulls
          Claudes from multiple providers, one header chip can't tell
          users which actual person added each one. */}
      <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
        {isPremium && cardOwner ? (
          <OwnerChip owner={cardOwner} variant="card" />
        ) : (
          <span />
        )}
        {isCopied ? (
          <span
            className={
              isPremium
                ? "inline-flex items-center gap-1 text-[10px] font-bold text-amber-200"
                : "inline-flex items-center gap-1 text-[10px] font-medium text-primary"
            }
          >
            <Check className="h-3 w-3" />
            Copied
          </span>
        ) : (
          <span
            className={
              isPremium
                ? "inline-flex items-center gap-1 text-[10px] text-amber-200/70 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                : "inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            }
          >
            <Copy className="h-3 w-3" />
            Click to copy
          </span>
        )}
      </div>
    </article>
  );
}

/**
 * "added by [avatar] [name]" pill rendered next to the section header
 * (standard sections) or inside each card (premium section, where the
 * provider differs per-card).
 *
 * Avatar URLs follow Discord's CDN pattern. When `avatar` is null
 * (user never set one, or their row was backfilled by ensureUserExists
 * with no avatar hash), we render an initial-letter bubble instead so
 * the chip never collapses to "added by  Username" with a hole.
 */
function OwnerChip({
  owner,
  variant,
}: {
  owner: NonNullable<Owner>;
  variant: "header" | "card";
}) {
  const isHeader = variant === "header";
  return (
    <span
      className={
        isHeader
          ? "inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          : "inline-flex items-center gap-1 text-[10px] text-amber-200/80"
      }
      title={`Added by ${owner.username}`}
    >
      <span className={isHeader ? "opacity-70" : "opacity-80"}>added by</span>
      {owner.avatar ? (
        <img
          src={`https://cdn.discordapp.com/avatars/${owner.id}/${owner.avatar}.png?size=32`}
          alt=""
          className={isHeader ? "w-4 h-4 rounded-full" : "w-3.5 h-3.5 rounded-full"}
        />
      ) : (
        <span
          className={
            isHeader
              ? "w-4 h-4 rounded-full bg-primary/20 text-[8px] text-primary flex items-center justify-center"
              : "w-3.5 h-3.5 rounded-full bg-amber-400/20 text-[8px] text-amber-200 flex items-center justify-center"
          }
        >
          {owner.username.charAt(0).toUpperCase()}
        </span>
      )}
      <span
        className={
          isHeader
            ? "font-medium text-card-foreground"
            : "font-semibold text-amber-100"
        }
      >
        {owner.username}
      </span>
    </span>
  );
}
