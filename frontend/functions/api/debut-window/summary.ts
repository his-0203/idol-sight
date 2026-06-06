// frontend/functions/api/debut-window/summary.ts
//
// Returns per-(group, frontend_bucket) organicity summary. Optional ?bucket=X
// filter on frontend bucket (D-60/D-30/D-Day/D+30/D+60).
//
// V3 (2026-05-25): worker 가 9 bucket (+ Pre/Post) 으로 row 를 저장하지만
// frontend KPI 는 5 탭만 노출. 이 endpoint 가 9 → 5 union aggregate 를 SQL
// GROUP BY 로 처리. 가중치:
//   - organic_score_mean      : total_views 가중 평균
//   - 5-tier ratio (organic_strong/organic/borderline/suspect/likely_paid)
//                             : video_count 가중 평균
//   - count/views/engagement  : SUM
//   - computed_at             : MAX
// videos.ts 와 같은 FRONTEND_BUCKET_MAP 을 공유 (lib/debutWindowBuckets).

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";
import { FRONTEND_BUCKET_MAP, VALID_BUCKETS } from "../../lib/debutWindowBuckets";

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  long_form_count: number;
  short_form_count: number;
  organic_score_mean: number | null;
  organic_score_mean_long: number | null;
  organic_score_mean_short: number | null;
  organic_score_mean_simple: number | null;
  organic_strong_ratio: number | null;
  organic_ratio: number | null;
  borderline_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
  total_views: number;
  total_engagement: number;
  computed_at: string;
}

// SQL CASE 식 — worker bucket → frontend bucket 매핑.
// (FRONTEND_BUCKET_MAP 을 역인덱스로 전개해 CASE WHEN 생성.)
function buildBucketCase(): string {
  const lines: string[] = [];
  for (const [frontendBucket, workerBuckets] of Object.entries(FRONTEND_BUCKET_MAP)) {
    for (const wb of workerBuckets) {
      // 따옴표 escape — bucket 라벨은 코드 상수라 안전하지만 방어적.
      const safeWb = wb.replace(/'/g, "''");
      const safeFb = frontendBucket.replace(/'/g, "''");
      lines.push(`    WHEN window_bucket = '${safeWb}' THEN '${safeFb}'`);
    }
  }
  return `CASE\n${lines.join("\n")}\n  END`;
}

// FRONTEND_BUCKET_MAP 에 포함된 worker bucket 만 union 대상 (Pre/Post 제외).
const ALL_WORKER_BUCKETS: string[] = Object.values(FRONTEND_BUCKET_MAP).flat();

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");

  let targetWorkerBuckets: string[];
  if (bucket) {
    if (!VALID_BUCKETS.has(bucket)) {
      return jsonResponse({ error: "invalid bucket" }, 400);
    }
    targetWorkerBuckets = FRONTEND_BUCKET_MAP[bucket]!;
  } else {
    targetWorkerBuckets = ALL_WORKER_BUCKETS;
  }

  const placeholders = targetWorkerBuckets.map(() => "?").join(",");
  const bucketCase = buildBucketCase();

  // video_count 가중 ratio: WHEN SUM(video_count)=0 THEN NULL ELSE … END.
  // total_views 가중 score: WHEN SUM(total_views)=0 THEN NULL ELSE … END.
  // organic_score_mean 은 row 에 NULL 가능 (insufficient_data 등) → 0 로 변환
  // 후 가중치 (total_views) 곱 → SUM. NULL 가중 mean 의 표준 처리.
  const sql = `
    SELECT
      group_key,
      ${bucketCase} AS window_bucket,
      SUM(video_count)       AS video_count,
      SUM(long_form_count)   AS long_form_count,
      SUM(short_form_count)  AS short_form_count,
      CASE WHEN SUM(total_views) > 0
        THEN SUM(COALESCE(organic_score_mean, 0) * total_views) * 1.0
             / SUM(total_views)
        ELSE NULL END        AS organic_score_mean,
      -- Type-split means (CompetitorOrganicityBar long/short/all_simple modes).
      -- Weighted by the matching count so a bucket with no long (or no short)
      -- videos yields NULL rather than a fake 0. V2.34 buckets are 1:1 so this
      -- is a passthrough in practice.
      CASE WHEN SUM(long_form_count) > 0
        THEN SUM(COALESCE(organic_score_mean_long, 0) * long_form_count) * 1.0
             / SUM(long_form_count)
        ELSE NULL END        AS organic_score_mean_long,
      CASE WHEN SUM(short_form_count) > 0
        THEN SUM(COALESCE(organic_score_mean_short, 0) * short_form_count) * 1.0
             / SUM(short_form_count)
        ELSE NULL END        AS organic_score_mean_short,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(organic_score_mean_simple, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS organic_score_mean_simple,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(organic_strong_ratio, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS organic_strong_ratio,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(organic_ratio, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS organic_ratio,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(borderline_ratio, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS borderline_ratio,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(suspect_ratio, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS suspect_ratio,
      CASE WHEN SUM(video_count) > 0
        THEN SUM(COALESCE(likely_paid_ratio, 0) * video_count) * 1.0
             / SUM(video_count)
        ELSE NULL END        AS likely_paid_ratio,
      COALESCE(SUM(total_views), 0)      AS total_views,
      COALESCE(SUM(total_engagement), 0) AS total_engagement,
      MAX(computed_at)                   AS computed_at
    FROM debut_window_organicity_summary
    WHERE window_bucket IN (${placeholders})
    GROUP BY group_key, window_bucket
    ORDER BY group_key ASC, window_bucket ASC
  `;

  const rows = await d1Query<SummaryRow>(env.DB, sql, targetWorkerBuckets);
  return jsonResponse({ rows }, 200);
};
