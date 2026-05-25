// frontend/functions/api/debut-window/videos-all.ts
//
// V3 (2026-05-25): 그룹의 *모든* 영상을 published_at DESC + 페이지네이션
// 으로 반환한다. organicity 가 없는 ±60d 밖 영상도 포함 (LEFT JOIN, NULL
// 컬럼). DebutWindowVideoTable 의 [전체 기간] view 가 이 endpoint 사용.
//
// 기존 /api/debut-window/videos 는 (group, bucket) 페어 조회 전용 그대로.
//
// Query params:
//   group  (required): group_key
//   offset (optional, default 0):  페이지 시작 row index
//   limit  (optional, default 30): 페이지 크기 (max 100)
//   type   (optional, default 'all'): all|long|short — Long-form/Shorts 필터
//
// Response: { group, type, total, offset, limit, rows }

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface VideoRowAll {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at: string;
  // organicity LEFT JOIN — ±60d 밖 영상은 모두 null.
  days_relative_to_debut: number | null;
  window_bucket: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  like_comment_ratio: number | null;
  velocity_ratio: number | null;
  organic_score: number | null;
  verdict: string | null;
  causes: string | null;
  signal_breakdown: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  const offsetRaw = url.searchParams.get("offset");
  const limitRaw = url.searchParams.get("limit");
  const type = url.searchParams.get("type") ?? "all";

  if (!group) return jsonResponse({ error: "group required" }, 400);
  if (!["all", "long", "short"].includes(type)) {
    return jsonResponse({ error: "type must be all|long|short" }, 400);
  }

  let offset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10);
  let limit  = limitRaw  === null ? DEFAULT_LIMIT : parseInt(limitRaw, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const typeFilter =
    type === "long"  ? " AND v.is_short = 0"
    : type === "short" ? " AND v.is_short = 1"
    : "";

  // 영상 stats 는 organicity 가 없을 수도 있는 영상의 view/like/comment 를
  // 컬럼에 채우기 위해 별도 LEFT JOIN. organicity 가 있는 경우는 o.view_count
  // 등이 채워져 있어 stats LEFT JOIN 의 동일 컬럼을 덮어쓰지 않도록 COALESCE.
  const rowsSql = `
    SELECT v.video_id, v.title, v.is_short, v.published_at,
           o.days_relative_to_debut, o.window_bucket,
           COALESCE(o.view_count,    s.views)    AS view_count,
           COALESCE(o.like_count,    s.likes)    AS like_count,
           COALESCE(o.comment_count, s.comments) AS comment_count,
           o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
           o.organic_score, o.verdict, o.causes, o.signal_breakdown
    FROM youtube_videos v
    LEFT JOIN debut_window_video_organicity o ON o.video_id = v.video_id
    LEFT JOIN youtube_video_stats s
      ON s.video_id = v.video_id
     AND s.snapshot_at = (
       SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id
     )
    WHERE v.group_key = ?${typeFilter}
    ORDER BY v.published_at DESC
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) AS n
    FROM youtube_videos v
    WHERE v.group_key = ?${typeFilter}
  `;

  const rows = await d1Query<VideoRowAll>(env.DB, rowsSql, [group, limit, offset]);
  const countRow = await d1Query<{ n: number }>(env.DB, countSql, [group]);
  const total = countRow[0]?.n ?? 0;

  return jsonResponse({ group, type, total, offset, limit, rows }, 200);
};
