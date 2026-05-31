// ─────────────────────────────────────────────────────────────────────────────
// CLOSED-MODE LANDING PAGE  (currently dormant)
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the "we are closed" takeover screen. It is NOT what's rendered at
// `/` right now — `LandingPage.tsx` (the normal landing page) is. This file
// only ships when somebody renames it to `LandingPage.tsx`, swapping out the
// active page.
//
// Full close/reopen playbook:
//     docs/CLOSED-MODE.md
//
// TL;DR for closing:
//   1.  mv src/app/components/LandingPage.tsx
//          src/app/components/LandingPage.original.tsx
//   2.  mv src/app/components/LandingPage.closed.tsx
//          src/app/components/LandingPage.tsx
//   3.  redeploy with `vercel --prod`
//
// The dashboard, /admin, /v1/* and the Discord bot are untouched by this
// swap — closed mode is front-page-only. If you want a harder shutdown,
// see the "Going further" section of docs/CLOSED-MODE.md.
// ─────────────────────────────────────────────────────────────────────────────

import { Cat } from "lucide-react";

export function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden p-6">
      {/* Same crimson backdrop as the original landing page so the closed
          screen feels like the same site, just dimmed out. Kept in sync
          with LandingPage.original.tsx — if the brand colors change, update
          both or restore the original first and re-apply this overlay. */}
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
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at center, transparent 32%, rgba(14, 4, 8, 0.78) 100%)",
          }}
        />
        {/* Floating decorations dimmed further than the original (0.06 vs
            0.10) so the page reads as quiet / shuttered rather than
            playful. */}
        <div className="animate-float-slow absolute left-12 top-16 text-5xl opacity-[0.06]">🐱</div>
        <div className="animate-float-slower absolute right-12 top-20 text-4xl opacity-[0.06]">🌸</div>
        <div className="animate-float-slow absolute bottom-16 left-20 text-4xl opacity-[0.06]">🌺</div>
        <div className="animate-float-slower absolute bottom-10 right-16 text-5xl opacity-[0.06]">🏵️</div>
      </div>

      {/* Centered closed-notice card. No login button, no stats, no model
          list — those are intentionally omitted (a closed site doesn't
          need a login). */}
      <div className="relative z-10 mx-auto flex min-h-screen max-w-2xl items-center justify-center">
        <div
          className="animate-fade-up rounded-2xl border-2 border-primary/60 bg-card/90 p-10 text-center backdrop-blur-sm"
        >
          <div className="mb-6 flex items-center justify-center gap-3 text-5xl">
            <span aria-hidden>🐱</span>
            <span aria-hidden>🌸</span>
          </div>

          <div className="mb-4 flex items-center justify-center gap-3">
            <Cat className="h-8 w-8 text-primary" />
            <h1 className="text-primary text-3xl font-bold">Crimson's Proxy</h1>
            <Cat className="h-8 w-8 text-primary" />
          </div>

          <p className="mb-2 text-2xl font-bold uppercase tracking-widest text-primary">
            Closed
          </p>
          <p className="mb-6 text-base text-muted-foreground">
            The service is no longer accepting new requests.
          </p>
          <p className="text-sm text-muted-foreground">
            Thanks for using Crimson's Proxy 💖
          </p>
        </div>
      </div>
    </div>
  );
}
