// frontend/functions/api/debut-window/summary.ts
//
// Returns per-(group, bucket) organicity summary. Optional ?bucket=X filter.

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  long_form_count: number;
  short_form_count: number;
  organic_score_mean: number | null;
  organic_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
  total_views: number;
  total_engagement: number;
  computed_at: string;
}

const VALID_BUCKETS = new Set(["D-60", "D-30", "D-Day", "D+30", "D+60"]);

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");
  let sql = `SELECT * FROM debut_window_organicity_summary`;
  const params: string[] = [];
  if (bucket) {
    if (!VALID_BUCKETS.has(bucket)) {
      return jsonResponse({ error: "invalid bucket" }, 400);
    }
    sql += ` WHERE window_bucket = ?`;
    params.push(bucket);
  }
  sql += ` ORDER BY group_key ASC, window_bucket ASC`;
  const rows = await d1Query<SummaryRow>(env.DB, sql, params);
  return jsonResponse({ rows }, 200);
};
