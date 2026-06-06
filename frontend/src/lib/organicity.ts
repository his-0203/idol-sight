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
