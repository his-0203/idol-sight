-- migrations/0020_video_view_backfill.sql
-- Backfill yt_total_videos + yt_total_views from Wayback YouTube channel
-- snapshots. Migration 0018 only filled yt_subscribers + naver_total_news.
-- This migration extends the existing rows (via ON CONFLICT UPDATE) to
-- populate the missing video count + total views per group.
--
-- Source: Wayback Machine snapshots of YouTube channel home pages and /about pages.
-- Parsing patterns used:
--   yt_total_videos:
--     1. "videosCountText":{"runs":[{"text":"127"},{"text":" videos"}]}  (PLAVE 2022-2023 format)
--     2. "metadataParts":[{"text":{"content":"121 videos"}}]  (SKINZ 2024-2025 format)
--   yt_total_views:
--     "viewCountText":{"simpleText":"7,474,945 views"} adjacent to "joinedDateText"
--     on the channel /about page only (NOT available on home page).
--
-- PLAVE:
--   - 9 home-page snapshots: all have yt_total_videos (pattern 1)
--   - 1 /about-page snapshot (20230327074623): has yt_total_views = 7,474,945
--   - yt_total_videos also filled for the about-page date row
--
-- SKINZ:
--   - 2 home-page snapshots: both have yt_total_videos (pattern 2)
--   - 0 /about-page snapshots: yt_total_views stays NULL for SKINZ
--
-- MYRAKL / OWIS:
--   - 0 Wayback snapshots found — no data, blocks omitted entirely.
--
-- Idempotent — re-running has no effect (excluded values are same as
-- existing values once applied).

-- ============================================================
-- PLAVE backfill (yt_total_videos + yt_total_views)
-- ============================================================
-- Only rows with non-NULL yt_total_videos or yt_total_views are included.
-- Rows without YouTube data (naver-only) are already in 0018 and not repeated.
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('plave', '2022-11-02T00:00:00Z', 25, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2022-11-09T00:00:00Z', 25, NULL, 1010,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-25T00:00:00Z', 127, NULL, 91300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-27T00:00:00Z', 127, 7474945, 107000,
   0, 0, 0, 50, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-29T00:00:00Z', 129, NULL, 134000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-03-30T00:00:00Z', 130, NULL, 138000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-15T00:00:00Z', 139, NULL, 206000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-04-20T00:00:00Z', 140, NULL, 213000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-05T00:00:00Z', 145, NULL, 243000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('plave', '2023-05-18T00:00:00Z', 153, NULL, 263000,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_total_videos  = COALESCE(excluded.yt_total_videos, agg_summary.yt_total_videos),
  yt_total_views   = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;

-- ============================================================
-- SKINZ backfill (yt_total_videos only — no /about snapshots)
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('skinz', '2024-12-27T00:00:00Z', 4, NULL, 1340,
   0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2025-07-08T00:00:00Z', 121, NULL, 61300,
   0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_total_videos  = COALESCE(excluded.yt_total_videos, agg_summary.yt_total_videos),
  yt_total_views   = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  data_source      = excluded.data_source;

-- ============================================================
-- MYRAKL / OWIS: no Wayback snapshots found — blocks omitted.
-- ============================================================
