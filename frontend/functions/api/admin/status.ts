// /api/admin/status — operational health for the PM/operator. Behind the site
// auth (middleware 401s unauthenticated /api/*); surfaced in-app via the header
// "상태" button so "is everything actually running?" is one click, not tribal
// knowledge. Read-only; aggregates crawl_meta freshness + last aggregate + last
// alert + table-growth counts into a single ok/warn/critical rollup.
//
// The recurring failure mode this exists to kill: the pipeline stops quietly
// while the dashboard still renders yesterday's numbers.

import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface JobRow {
  job: string;
  source: string | null;
  group_key: string | null;
  expected_interval_h: number | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  status: string | null;
  error_msg: string | null;
}

// A job is "stale" when its last success is older than interval × this factor
// (mirrors the worker health-check's audit_freshness threshold).
const STALE_FACTOR = 4;

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const nowMs = Date.now();
  const hoursSince = (iso: string | null | undefined): number | null =>
    iso ? Math.round(((nowMs - Date.parse(iso)) / 3_600_000) * 10) / 10 : null;

  const [jobs, lastAgg, lastAlert, counts] = await Promise.all([
    d1Query<JobRow>(env.DB,
      "SELECT job, source, group_key, expected_interval_h, last_success_at, "
      + "       last_attempt_at, status, error_msg "
      + "FROM crawl_meta ORDER BY source, group_key"),
    d1QueryOne<{ m: string | null }>(env.DB,
      "SELECT MAX(snapshot_at) AS m FROM agg_summary"),
    d1QueryOne<{ m: string | null }>(env.DB,
      "SELECT MAX(fired_at) AS m FROM alerts"),
    d1QueryOne<Record<string, number>>(env.DB,
      "SELECT (SELECT COUNT(*) FROM youtube_videos)       AS videos, "
      + "       (SELECT COUNT(*) FROM youtube_video_stats) AS video_stats, "
      + "       (SELECT COUNT(*) FROM community_posts)      AS community_posts, "
      + "       (SELECT COUNT(*) FROM naver_articles)       AS naver_articles, "
      + "       (SELECT COUNT(*) FROM agg_summary)          AS snapshots"),
  ]);

  const jobRows = jobs.map((j) => {
    const h = hoursSince(j.last_success_at);
    const staleAfter = (j.expected_interval_h ?? 24) * STALE_FACTOR;
    const state: "ok" | "failed" | "stale" | "unknown" =
      j.status === "failed" ? "failed"
        : h == null ? "unknown"
          : h > staleAfter ? "stale"
            : "ok";
    return { ...j, hours_since_success: h, stale_after_h: staleAfter, state };
  });

  const overall: "ok" | "warn" | "critical" =
    jobRows.some((j) => j.state === "failed") ? "critical"
      : jobRows.some((j) => j.state === "stale" || j.state === "unknown") ? "warn"
        : "ok";

  return jsonResponse({
    generated_at: new Date().toISOString(),
    overall,
    jobs: jobRows,
    last_aggregate_at: lastAgg?.m ?? null,
    aggregate_hours_ago: hoursSince(lastAgg?.m),
    last_alert_at: lastAlert?.m ?? null,
    counts: counts ?? {},
  });
};
