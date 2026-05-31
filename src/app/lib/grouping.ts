/**
 * Shared model-grouping helpers used by LandingPage and Dashboard.
 *
 * The model catalog (/api/models) returns rows shaped
 *   { id: "pn/claude-opus-4-7", name: "pn/claude-opus-4-7", owned_by: "..." }
 * — the upstream-supplied `owned_by` is unreliable (one upstream
 * returns "fastino" for its own brand instead of the real vendor),
 * so UI grouping never reads it. We slice the model id on `/` to
 * extract the routing prefix (`pn`, `vx`, `tm`) — that's something
 * the proxy itself mints, so it can't be polluted by upstream
 * vendor naming.
 *
 * The Discord channel board, the /health slash command, and the
 * /status visual page all already group by prefix. This module
 * brings the LandingPage and Dashboard surfaces in line so all four
 * surfaces look the same.
 */

export type Model = { id: string; name: string; owned_by: string };

/** "pn/claude-opus-4-7" → "pn". Bare names (no slash) bucket as "_". */
export function prefixOf(model: Model): string {
  const slash = model.id.indexOf("/");
  return slash >= 0 ? model.id.slice(0, slash) : "_";
}

/**
 * Return the part after the first `/` — the bare model id users see
 * once a section header carries the prefix.
 */
export function bareIdOf(model: Model): string {
  const slash = model.id.indexOf("/");
  return slash >= 0 ? model.id.slice(slash + 1) : model.id;
}

/**
 * Claude detection from the bare model id (after the prefix).
 * Anchored on the `claude-` family name rather than the upstream
 * `owned_by` field so it survives whatever the upstream catalog
 * decides to label them as.
 */
export function isClaude(model: Model): boolean {
  return bareIdOf(model).toLowerCase().startsWith("claude-");
}

/**
 * Bucket models for landing/dashboard rendering.
 *
 * Returns:
 *   premium  — every Claude model across providers, surfaced as one
 *              top section so visitors can grab one without hunting
 *              through provider sections.
 *   byPrefix — alphabetical [prefix, models][]. Each Claude model
 *              ALSO appears in its prefix section (intentional
 *              duplication — power users going straight to "VX"
 *              still see all VX models, including Claudes).
 *
 * Models within each list are sorted alphabetically by name.
 */
export function groupForUi(models: Model[]): {
  premium: Model[];
  byPrefix: Array<[string, Model[]]>;
} {
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  const premium = sorted.filter(isClaude);

  const groups = new Map<string, Model[]>();
  for (const m of sorted) {
    const p = prefixOf(m);
    const list = groups.get(p) ?? [];
    list.push(m);
    groups.set(p, list);
  }
  const byPrefix = Array.from(groups.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return { premium, byPrefix };
}
