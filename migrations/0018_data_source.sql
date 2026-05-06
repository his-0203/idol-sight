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

-- ============================================================
-- PLAVE backfill via scrape.py (Wayback Machine snapshots)
-- debut 2023-03-12, window 2022-09-13 ~ 2023-06-10
-- Source: web.archive.org CDX API + snapshot fetch for @plave_official
-- 9 snapshots recovered — all traced to real HTTP responses.
-- Naver News: BLOCKED (403 from scraper IP) — naver_total_news=0 all rows
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('plave', '2022-11-02T00:00:00Z', NULL, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-09T00:00:00Z', NULL, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-25T00:00:00Z', NULL, NULL, 91300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-29T00:00:00Z', NULL, NULL, 134000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-30T00:00:00Z', NULL, NULL, 138000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-15T00:00:00Z', NULL, NULL, 206000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-20T00:00:00Z', NULL, NULL, 213000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-05T00:00:00Z', NULL, NULL, 243000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-18T00:00:00Z', NULL, NULL, 263000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- SKINZ backfill via scrape.py (Wayback Machine snapshots)
-- debut 2025-04-10, window 2024-10-12 ~ 2025-07-09
-- Source: web.archive.org CDX API + snapshot fetch for @SKINZOFFICIAL
-- 2 snapshots recovered — both traced to real HTTP responses.
-- Naver News: BLOCKED (403 from scraper IP) — naver_total_news=0 all rows
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('skinz', '2024-12-27T00:00:00Z', NULL, NULL, 1340,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-07-08T00:00:00Z', NULL, NULL, 61300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- STEALTH PASS: Scrapling StealthyFetcher (Playwright/Chromium)
-- Naver News: unblocked via stealth mode — weekly counts for all 4 groups
-- Social Blade: free tier = last 14 days only (historical data behind paywall)
-- Run: uv run scripts/historical_backfill/scrape.py --group X --stealth
-- ============================================================

-- ============================================================
-- PLAVE backfill via scrape.py (Wayback + Naver stealth + Social Blade)
-- debut 2023-03-12, window 2022-09-13 ~ 2023-06-10
-- yt_subscribers rows: 9 (Wayback Machine + Social Blade free tier)
-- naver_total_news rows with >0: 12 (StealthyFetcher/Playwright)
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('plave', '2022-09-19T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-09-26T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-10-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-10-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-10-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-10-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2022-10-31T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-02T00:00:00Z', NULL, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-07T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-09T00:00:00Z', NULL, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-14T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-21T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-28T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-12-05T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-12-12T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-12-19T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-12-26T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-01-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-01-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-01-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-01-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-01-30T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-02-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2023-02-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-02-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-02-27T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 10, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 16, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-25T00:00:00Z', NULL, NULL, 91300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-27T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 50, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-29T00:00:00Z', NULL, NULL, 134000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-30T00:00:00Z', NULL, NULL, 138000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 2, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-15T00:00:00Z', NULL, NULL, 206000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-20T00:00:00Z', NULL, NULL, 213000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-01T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-05T00:00:00Z', NULL, NULL, 243000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-08T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-15T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-18T00:00:00Z', NULL, NULL, 263000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-22T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 2, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-29T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 4, 0, 0, 'backfill_estimate'),
  ('plave', '2023-06-05T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- SKINZ backfill via scrape.py (Wayback + Naver stealth + Social Blade)
-- debut 2025-04-10, window 2024-10-12 ~ 2025-07-09
-- yt_subscribers rows: 2 (Wayback Machine + Social Blade free tier)
-- naver_total_news rows with >0: 7 (StealthyFetcher/Playwright)
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('skinz', '2024-10-14T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-10-21T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-10-28T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-11-04T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-11-11T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-11-18T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-11-25T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 50, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-27T00:00:00Z', NULL, NULL, 1340,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2024-12-30T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-01-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-01-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-01-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-01-27T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-02-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-02-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-02-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-02-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-03-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-03-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1001, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-03-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-03-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1001, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-03-31T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-04-07T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-04-14T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-04-21T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-04-28T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-05-05T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-05-12T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-05-19T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 5, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-05-26T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-06-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-06-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-06-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-06-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-06-30T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-07-07T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1001, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-07-08T00:00:00Z', NULL, NULL, 61300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- MYRAKL backfill via scrape.py (Wayback + Naver stealth + Social Blade)
-- debut 2026-01-26, window 2025-07-30 ~ 2026-04-26
-- yt_subscribers rows: 4 (Wayback Machine + Social Blade free tier)
-- naver_total_news rows with >0: 0 (StealthyFetcher/Playwright)
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('myrakl', '2025-08-04T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-08-11T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-08-18T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-08-25T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-09-01T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-09-08T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-09-15T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-09-22T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-09-29T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-10-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-10-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-10-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-10-27T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-11-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-11-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-11-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-11-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-12-01T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-12-08T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-12-15T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-12-22T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2025-12-29T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-01-05T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-01-12T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-01-19T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-01-26T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-02-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-02-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-02-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-02-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-03-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-03-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-03-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-03-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-03-30T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-23T00:00:00Z', NULL, NULL, 5430,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-24T00:00:00Z', NULL, NULL, 5430,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-25T00:00:00Z', NULL, NULL, 5440,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-26T00:00:00Z', NULL, NULL, 5430,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- OWIS backfill via scrape.py (Wayback + Naver stealth + Social Blade)
-- debut 2026-03-23, window 2025-09-24 ~ 2026-05-06
-- yt_subscribers rows: 14 (Wayback Machine + Social Blade free tier)
-- naver_total_news rows with >0: 6 (StealthyFetcher/Playwright)
-- Social Blade handle: owis_official (OWISofficial = 404 on SB)
-- See scripts/historical_backfill/SOURCES.md for per-row provenance.
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('owis', '2025-09-29T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-10-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-10-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-10-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-10-27T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-11-03T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-11-10T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-11-17T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-11-24T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-12-01T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-12-08T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-12-15T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-12-22T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2025-12-29T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-01-05T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 16, 0, 0, 'backfill_estimate'),
  ('owis', '2026-01-12T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 50, 0, 0, 'backfill_estimate'),
  ('owis', '2026-01-19T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-01-26T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-02-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-02-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-02-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-02-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 1001, 0, 0, 'backfill_estimate'),
  ('owis', '2026-03-02T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-03-09T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-03-16T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-03-23T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-03-30T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-06T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-13T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 4, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-20T00:00:00Z', NULL, NULL, NULL,
   0, 0, 0, 8, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-23T00:00:00Z', NULL, NULL, 65099,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-24T00:00:00Z', NULL, NULL, 65200,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-25T00:00:00Z', NULL, NULL, 66400,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-26T00:00:00Z', NULL, NULL, 66200,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-27T00:00:00Z', NULL, NULL, 66100,
   0, 0, 0, 1, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-28T00:00:00Z', NULL, NULL, 66000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-29T00:00:00Z', NULL, NULL, 66100,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-04-30T00:00:00Z', NULL, NULL, 66100,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-01T00:00:00Z', NULL, NULL, 66200,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-02T00:00:00Z', NULL, NULL, 66300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-03T00:00:00Z', NULL, NULL, 66600,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-04T00:00:00Z', NULL, NULL, 66900,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-05T00:00:00Z', NULL, NULL, 67100,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('owis', '2026-05-06T00:00:00Z', NULL, NULL, 67300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- Fix PLAVE 2023-04-25 monotonicity violation
-- Wikipedia "100K celebration" 2023-04-25 was a public announcement of
-- having SURPASSED 100K some weeks prior, not a real point-in-time count.
-- Wayback Machine proves 134,000 subscribers by 2023-03-29.
-- The wiki value is NULL'd to preserve curve integrity.
-- See scripts/historical_backfill/SOURCES.md §PLAVE for full analysis.
-- ============================================================
UPDATE agg_summary
   SET yt_subscribers = NULL
 WHERE group_key = 'plave'
   AND snapshot_at = '2023-04-25T00:00:00Z';
