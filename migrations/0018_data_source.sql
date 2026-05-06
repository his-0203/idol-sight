-- migrations/0018_data_source.sql
-- agg_summary.data_source: 행 출처 분류
--   live              = collector 실측
--   backfill_exact    = 검증 가능한 백필 (네이버 뉴스 키워드 카운트 등)
--   backfill_estimate = 본질적 추정 (Social Blade 구독자, cumulative views)
--
-- weakest-link 룰: 한 행에 estimate 컬럼이 하나라도 있으면 행 전체를
-- backfill_estimate로 표시. UI는 보수적으로 "추정"으로 렌더 — false
-- positive 방향(살짝 더 조심)으로만 동작.
ALTER TABLE agg_summary
  ADD COLUMN data_source TEXT NOT NULL DEFAULT 'live'
  CHECK(data_source IN ('live', 'backfill_exact', 'backfill_estimate'));

CREATE INDEX idx_agg_summary_source
  ON agg_summary(group_key, data_source, snapshot_at);

-- 회고 분류: 기존 yt_history_backfill 행 시그니처는
-- yt_subscribers IS NULL + 비-YT 컬럼 모두 0 + cumulative views가
-- over-estimate. 따라서 backfill_estimate로 마킹.
UPDATE agg_summary
   SET data_source = 'backfill_estimate'
 WHERE yt_subscribers IS NULL
   AND dc_total_posts = 0 AND theqoo_posts = 0 AND instiz_posts = 0
   AND naver_total_news = 0 AND twitter_posts = 0
   AND controversy_count = 0;

-- 백필 INSERT은 후속 Task에서 이 파일에 append.
