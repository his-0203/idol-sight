// Ordered display-tab list for the Debut Window UI: the 7 named buckets, in
// chronological order. Hand-copied identically into DebutWindowVideoTable,
// DebutWindowKPI, and CompetitorOrganicityBar — single-sourced here.
//
// V2.34 (2026-05-27): worker WINDOW_BUCKETS unified to 7 named × 20-day buckets
// (+ Pre/Post catch-all), 1:1 with the frontend tabs. Must stay aligned with
// functions/lib/debutWindowBuckets VALID_BUCKETS (guarded by
// tests/lib/debutWindow.test.ts) and the worker WINDOW_BUCKETS.
export const DISPLAY_BUCKETS = [
  "D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60",
] as const;

export type DisplayBucket = typeof DISPLAY_BUCKETS[number];
