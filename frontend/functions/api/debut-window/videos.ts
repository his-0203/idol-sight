// frontend/functions/api/debut-window/videos.ts
//
// Returns videos in a (group, bucket) window with their signal_breakdown.
// Joins youtube_videos for title. Required: group, bucket. Optional:
// type=long|short|all (default all).

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";
import { FRONTEND_BUCKET_MAP, VALID_BUCKETS } from "../../lib/debutWindowBuckets";

interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at: string;
  days_relative_to_debut: number;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  like_comment_ratio: number | null;
  velocity_ratio: number | null;
  organic_score: number | null;
  verdict: string;
  causes: string | null;
  signal_breakdown: string;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  const bucket = url.searchParams.get("bucket");
  const type = url.searchParams.get("type") ?? "all";

  if (!group) return jsonResponse({ error: "group required" }, 400);
  if (!bucket || !VALID_BUCKETS.has(bucket)) {
    return jsonResponse({ error: "valid bucket required" }, 400);
  }
  if (!["all", "long", "short"].includes(type)) {
    return jsonResponse({ error: "type must be all|long|short" }, 400);
  }

  const workerBuckets = FRONTEND_BUCKET_MAP[bucket]!;   // VALID_BUCKETS 통과 보장
  const bucketPlaceholders = workerBuckets.map(() => "?").join(",");
  let sql = `
    SELECT o.video_id, v.title, o.is_short, o.published_at,
           o.days_relative_to_debut,
           o.view_count, o.like_count, o.comment_count,
           o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
           o.organic_score, o.verdict, o.causes, o.signal_breakdown
    FROM debut_window_video_organicity o
    LEFT JOIN youtube_videos v ON v.video_id = o.video_id
    WHERE o.group_key = ? AND o.window_bucket IN (${bucketPlaceholders})
  `;
  const params: (string | number)[] = [group, ...workerBuckets];
  if (type === "long") {
    sql += ` AND o.is_short = 0`;
  } else if (type === "short") {
    sql += ` AND o.is_short = 1`;
  }
  sql += ` ORDER BY o.days_relative_to_debut ASC, o.published_at ASC`;

  const rows = await d1Query<VideoRow>(env.DB, sql, params);
  return jsonResponse({ group, bucket, type, rows }, 200);
};
