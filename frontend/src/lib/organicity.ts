// Single source of truth for Debut Window organicity verdict tiers + colors.
//
// The 5-tier boundaries (85/70/55/40) and their colors were hand-copied into
// DebutWindowVideoTable, DebutWindowKPI, DebutWindowSignalPanel, and
// CompetitorOrganicityBar — a recalibration in one silently desynced the color
// meaning in the others (e.g. the V2.21 → V2.37 churn). Import from here so the
// scale lives in exactly one place.
//
// Mirrors the worker boundaries in
// worker/src/idol_sight/analysis/debut_window.py:_classify_verdict.
// Cross-language drift is guarded by tests/lib/organicity.test.ts.

export const ORGANIC_NEUTRAL_COLOR = "#6b7280"; // insufficient_data / null / unknown

// score >= threshold → that tier (descending).
export const VERDICT_THRESHOLDS = {
  organic_strong: 85,
  organic: 70,
  borderline: 55,
  suspect: 40,
} as const;

export const VERDICT_COLOR = {
  organic_strong: "#16a34a",
  organic: "#22c55e",
  borderline: "#eab308",
  suspect: "#f97316",
  likely_paid: "#ef4444",
} as const;

export type Verdict = keyof typeof VERDICT_COLOR;

export function scoreToVerdict(score: number): Verdict {
  if (score >= VERDICT_THRESHOLDS.organic_strong) return "organic_strong";
  if (score >= VERDICT_THRESHOLDS.organic) return "organic";
  if (score >= VERDICT_THRESHOLDS.borderline) return "borderline";
  if (score >= VERDICT_THRESHOLDS.suspect) return "suspect";
  return "likely_paid";
}

/** Color for a 0-100 organic score; neutral gray for null/undefined. */
export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return ORGANIC_NEUTRAL_COLOR;
  return VERDICT_COLOR[scoreToVerdict(score)];
}

/** Color for a verdict string; neutral gray for insufficient_data/null/unknown. */
export function verdictColor(v: string | null | undefined): string {
  if (v && v in VERDICT_COLOR) return VERDICT_COLOR[v as Verdict];
  return ORGANIC_NEUTRAL_COLOR;
}

// V2.40 Finding 3: the default organicity lens is the COUNT-BASED simple mean,
// not the view-weighted mean. View-weighting lets one high-view outlier — e.g.
// the operator-confirmed paid PLUMA MV teaser — dominate a bucket whose catalog
// is otherwise organic, overstating paid-ness. The simple mean answers "how
// organic is the content?" (the defensible question for MiiWAN's dual-track
// reporting); the view-weighted mean ("how organic is the reach?") stays
// available as an explicit toggle in CompetitorOrganicityBar. Centralized here
// so the two consumers (DebutWindowKPI headline + the bar's default mode) can't
// silently desync — the same hazard this file's header warns about.
export const DEFAULT_ORGANICITY_MODE = "all_simple" as const;

// V2.50 thin-sample shrinkage. organicity is volume-independent BY DESIGN
// (authenticity, not growth — growth lives in the Growth Trajectory layer), so
// a bucket with 1-2 scored videos shows a confident organic_strong from almost
// no evidence: "few organic videos → high score despite no growth" (operator
// flag). The worker now stores organic_score_mean_shrunk — the simple mean
// pulled toward the neutral prior (55) with pseudocount k=3, vanishing as real
// volume accumulates — and scored_video_count, the true sample size. Buckets
// below THIN_SAMPLE_MAX scored videos are flagged in the UI. Mirrors the worker
// constants in debut_window.py (ORGANICITY_PRIOR / ORGANICITY_SHRINKAGE_K);
// drift is guarded by tests/lib/organicity.test.ts.
export const THIN_SAMPLE_MAX = 3; // scored_video_count < this → thin sample

/** True when a bucket's scored sample is too thin to trust its headline. */
export function isThinSample(scoredVideoCount: number | null | undefined): boolean {
  return (scoredVideoCount ?? 0) < THIN_SAMPLE_MAX;
}

/** The per-bucket mean variants returned by /api/debut-window/summary. */
export interface OrganicityMeans {
  organic_score_mean: number | null;        // view-weighted (reach lens)
  organic_score_mean_simple: number | null; // count-based (catalog lens)
  // V2.50 headline: simple mean shrunk toward neutral for thin buckets. Null on
  // pre-0092 rows → headlineOrganicScore falls back to the raw simple mean.
  organic_score_mean_shrunk?: number | null;
}

/**
 * Headline organic score for a summary row: the thin-sample-shrunk simple mean
 * (V2.50), falling back to the raw simple mean when shrunk is absent (pre-0092
 * rows). Null means the bucket has no scored videos.
 */
export function headlineOrganicScore(row: OrganicityMeans): number | null {
  return row.organic_score_mean_shrunk ?? row.organic_score_mean_simple ?? null;
}

// ── Group-level organicity collapse (shared by CompetitorOrganicityBar +
// MarketOverview). Extracted from CompetitorOrganicityBar so the bucket
// fallback + thin-sample rule live in exactly one place — same single-source
// discipline this file's header enforces for the color scale. ──────────────

export type OrganicityMode = "all_weighted" | "all_simple" | "long" | "short";

export interface OrganicitySummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;        // view-weighted
  organic_score_mean_long: number | null;
  organic_score_mean_short: number | null;
  organic_score_mean_simple: number | null; // count-based
  organic_score_mean_shrunk: number | null; // thin-sample-shrunk headline
  video_count: number;
  scored_video_count: number;
  long_form_count: number;
  short_form_count: number;
}

export type OrganicityDisplayMode = "exact" | "current" | "none";

export interface GroupOrganicity {
  group_key: string;
  score: number | null;
  sample_count: number;
  scored_count: number;
  thin: boolean;
  display_mode: OrganicityDisplayMode;
  shown_bucket: string;
}

/** Score column for a mode. all_simple = thin-sample-shrunk headline (V2.50),
 * falling back to the raw simple mean on pre-0092 rows. */
export function organicityScoreFor(row: OrganicitySummaryRow, mode: OrganicityMode): number | null {
  if (mode === "all_weighted") return row.organic_score_mean;
  if (mode === "all_simple")   return row.organic_score_mean_shrunk ?? row.organic_score_mean_simple;
  if (mode === "long")         return row.organic_score_mean_long;
  return row.organic_score_mean_short;
}

export function organicitySampleCountFor(row: OrganicitySummaryRow, mode: OrganicityMode): number {
  if (mode === "long")  return row.long_form_count;
  if (mode === "short") return row.short_form_count;
  return row.video_count;
}

/** Collapse a group's per-bucket rows to one display value:
 *  exact (selected bucket scored) → current (newest scored bucket) → none. */
export function selectGroupOrganicity(
  byBucket: Map<string, OrganicitySummaryRow>,
  selected: string,
  mode: OrganicityMode,
  groupKey: string,
  bucketsOrdered: readonly string[],
): GroupOrganicity {
  const exact = byBucket.get(selected);
  if (exact && organicityScoreFor(exact, mode) !== null) {
    const sample = organicitySampleCountFor(exact, mode);
    return {
      group_key: groupKey, score: organicityScoreFor(exact, mode),
      sample_count: sample, scored_count: exact.scored_video_count,
      thin: isThinSample(sample), display_mode: "exact", shown_bucket: selected,
    };
  }
  for (let i = bucketsOrdered.length - 1; i >= 0; i--) {
    const b = bucketsOrdered[i]!;
    const r = byBucket.get(b);
    if (r && organicityScoreFor(r, mode) !== null) {
      const sample = organicitySampleCountFor(r, mode);
      return {
        group_key: groupKey, score: organicityScoreFor(r, mode),
        sample_count: sample, scored_count: r.scored_video_count,
        thin: isThinSample(sample), display_mode: "current", shown_bucket: b,
      };
    }
  }
  return {
    group_key: groupKey, score: null, sample_count: 0, scored_count: 0,
    thin: false, display_mode: "none", shown_bucket: selected,
  };
}

/** Build a group_key → GroupOrganicity map at a given (bucket, mode). */
export function computeGroupOrganicities(
  rows: OrganicitySummaryRow[],
  opts: { buckets: readonly string[]; currentBucket: string; mode: OrganicityMode; excludeGroups?: ReadonlySet<string> },
): Map<string, GroupOrganicity> {
  const { buckets, currentBucket, mode, excludeGroups } = opts;
  const byGroup = new Map<string, Map<string, OrganicitySummaryRow>>();
  for (const r of rows) {
    if (excludeGroups?.has(r.group_key)) continue;
    if (!buckets.includes(r.window_bucket)) continue;
    let m = byGroup.get(r.group_key);
    if (!m) { m = new Map(); byGroup.set(r.group_key, m); }
    m.set(r.window_bucket, r);
  }
  const out = new Map<string, GroupOrganicity>();
  for (const [key, byBucket] of byGroup) {
    out.set(key, selectGroupOrganicity(byBucket, currentBucket, mode, key, buckets));
  }
  return out;
}

export interface OrganicityCaveat {
  show: boolean;
  verdict: Verdict | null;
  label: string;
}

// caution tiers only — organic / organic_strong never flag.
const CAVEAT_LABEL: Partial<Record<Verdict, string>> = {
  borderline: "오가닉성 주의",
  suspect: "유료 의심",
  likely_paid: "유료 의심↑",
};

/** Orthogonal caveat for a group's awareness card. Shows ONLY when the
 * organicity headline is in a caution tier AND the sample is not thin —
 * never folded into the awareness score (catalog flow-quality ≠ cumulative
 * reach; different scope). */
export function organicityCaveat(g: GroupOrganicity | null | undefined): OrganicityCaveat {
  if (!g || g.score === null || isThinSample(g.scored_count)) return { show: false, verdict: null, label: "" };
  const verdict = scoreToVerdict(g.score);
  const label = CAVEAT_LABEL[verdict];
  if (!label) return { show: false, verdict, label: "" };
  return { show: true, verdict, label };
}
