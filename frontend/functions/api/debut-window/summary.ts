// frontend/functions/api/debut-window/summary.ts
//
// Returns per-(group, window_bucket) organicity summary. Optional ?bucket=X
// filter on a single bucket label.
//
// V2.49: videos.ts 와 같은 debutWindowBuckets 산술 모듈을 공유.
// V2.49: 응답에 window 메타 (롤링 창 버킷 리스트 + 오늘 버킷) 동봉 —
// 프런트 3 컴포넌트 (KPI / CompetitorOrganicityBar / VideoTable) 가
// 정적 탭 대신 이 메타를 렌더한다.
//
// 가중치:
//   - organic_score_mean      : total_views 가중 평균
//   - 5-tier ratio (organic_strong/organic/borderline/suspect/likely_paid)
//                             : video_count 가중 평균
//   - count/views/engagement  : SUM
//   - computed_at             : MAX

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";
import {
  ANCHOR_GROUP_KEY,
  UNDATED_BUCKET,
  currentBucket,
  debutAgeDaysKST,
  displayBuckets,
  isValidBucketLabel,
} from "../../lib/debutWindowBuckets";

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
  organic_score_mean_shrunk: number | null;
  scored_video_count: number;
  organic_strong_ratio: number | null;
  organic_ratio: number | null;
  borderline_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
  total_views: number;
  total_engagement: number;
  computed_at: string;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");

  // V2.49 롤링 윈도우 — anchor(MiiWAN) 데뷔 경과일이 표시 창을 결정.
  // debut_date 미설정(이론상 없음)이면 age 0 → 데뷔 전 고정 창과 동일.
  // malformed 날짜 문자열(Date.parse NaN)도 0 으로 방어 — labelForIndex
  // throw 로 엔드포인트 전체가 500 나는 것 방지.
  const anchorRows = await d1Query<{ debut_date: string | null }>(
    env.DB, "SELECT debut_date FROM groups WHERE key = ?", [ANCHOR_GROUP_KEY],
  );
  const debutDate = anchorRows[0]?.debut_date ?? null;
  const rawAge = debutDate ? debutAgeDaysKST(debutDate, new Date()) : 0;
  const ageDays = Number.isFinite(rawAge) ? rawAge : 0;
  const windowBuckets = displayBuckets(ageDays);
  const nowBucket = currentBucket(ageDays);

  let targetBuckets: string[];
  if (bucket) {
    if (!isValidBucketLabel(bucket)) {
      return jsonResponse({ error: "invalid bucket" }, 400);
    }
    targetBuckets = [bucket];
  } else {
    // 카드 fetch (필터 없음): 창 7버킷 + Undated passthrough (V2.42).
    targetBuckets = [...windowBuckets, UNDATED_BUCKET];
  }

  const placeholders = targetBuckets.map(() => "?").join(",");

  // video_count 가중 ratio: WHEN SUM(video_count)=0 THEN NULL ELSE … END.
  // total_views 가중 score: WHEN SUM(total_views)=0 THEN NULL ELSE … END.
  // organic_score_mean 은 row 에 NULL 가능 (insufficient_data 등) → 0 로 변환
  // 후 가중치 (total_views) 곱 → SUM. NULL 가중 mean 의 표준 처리.
  // V2.34 부터 worker↔frontend 버킷 라벨이 1:1 identity 라 CASE 매핑 불필요.
  const sql = `
    SELECT
      group_key,
      window_bucket,
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
      -- V2.50 thin-sample headline: shrunk mean weighted by scored_video_count
      -- (its true sample size), NULL when no scored evidence. scored_video_count
      -- summed so the frontend can flag thin buckets. Pre-0092 rows carry NULL
      -- shrunk → frontend falls back to organic_score_mean_simple.
      CASE WHEN SUM(scored_video_count) > 0
        THEN SUM(COALESCE(organic_score_mean_shrunk, 0) * scored_video_count) * 1.0
             / SUM(scored_video_count)
        ELSE NULL END        AS organic_score_mean_shrunk,
      COALESCE(SUM(scored_video_count), 0) AS scored_video_count,
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

  const rows = await d1Query<SummaryRow>(env.DB, sql, targetBuckets);
  return jsonResponse({
    rows,
    window: { buckets: windowBuckets, current_bucket: nowBucket },
  }, 200);
};
