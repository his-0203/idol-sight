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

/** The two per-bucket mean variants returned by /api/debut-window/summary. */
export interface OrganicityMeans {
  organic_score_mean: number | null;        // view-weighted (reach lens)
  organic_score_mean_simple: number | null; // count-based (catalog lens, default)
}

/**
 * Headline organic score for a summary row: the count-based simple mean.
 * Both variants are null together (computed from the same scored set), so no
 * fallback is needed — a null here means the bucket has no scored videos.
 */
export function headlineOrganicScore(row: OrganicityMeans): number | null {
  return row.organic_score_mean_simple ?? null;
}
