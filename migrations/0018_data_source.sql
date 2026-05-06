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

-- ============================================================
-- PLAVE backfill (debut 2023-03-12, window 2022-09-13 ~ 2023-06-10)
-- Source: News/Wikipedia milestone reports @plave_official (UCPZIPuQPrfrUG9Xe_okEmQA)
-- naver_total_news: 0 (naver.com not accessible via web tools; gap documented)
-- (자세한 출처/방법론은 scripts/historical_backfill/SOURCES.md 참조)
-- ============================================================
-- Data points recovered: 2 (subscribers only)
--   2023-02-05: ~10,000  — "1만 기념" 멤버 영상 5편 업로드일 (pre-debut milestone)
--   2023-04-25: 100,000  — 첫 5인 전체 라이브 방송 100만 달성 기념일 (Wikipedia 확인)
-- Social Blade: 403 Forbidden. Playboard: current subs only (no history).
-- Naver News: naver.com blocked by WebFetch (0 news counts recoverable).
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  -- 2023-02-05: "1만 기념" milestone (pre-debut, 채널 개설 2022-06-16, 첫방송 2022-09-15)
  ('plave', '2023-02-05T00:00:00Z', NULL, NULL, 10000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  -- 2023-04-25: 첫 5인 전체 방송 — 10만 구독자 달성 기념 (Wikipedia 직접 확인)
  ('plave', '2023-04-25T00:00:00Z', NULL, NULL, 100000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;
