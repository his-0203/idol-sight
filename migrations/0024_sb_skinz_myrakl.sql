-- migrations/0024_sb_skinz_myrakl.sql
-- Social Blade default(30d) backfill for SKINZ + MYRAKL.
-- SKINZ: 30 rows current (D+392~D+421) — live anchor refinement.
-- MYRAKL: 30 rows current (D+71~D+100) — post-debut momentum window.
-- yt_total_videos NULL (not in SB daily). data_source=backfill_estimate.

-- ============================================================
-- SKINZ (30 rows 2026-04-07 ~ 2026-05-06)
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('skinz', '2026-04-07T00:00:00Z', NULL, 10609305, 66600, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-08T00:00:00Z', NULL, 10622446, 66600, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-09T00:00:00Z', NULL, 10631816, 66600, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-10T00:00:00Z', NULL, 10657858, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-11T00:00:00Z', NULL, 10674335, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-12T00:00:00Z', NULL, 10674335, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-13T00:00:00Z', NULL, 10674335, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-14T00:00:00Z', NULL, 10696448, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-15T00:00:00Z', NULL, 10708047, 66700, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-16T00:00:00Z', NULL, 10722726, 66800, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-17T00:00:00Z', NULL, 10734084, 66900, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-18T00:00:00Z', NULL, 10763419, 66900, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-19T00:00:00Z', NULL, 10774817, 66900, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-20T00:00:00Z', NULL, 10789243, 67000, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-21T00:00:00Z', NULL, 10789243, 67000, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-22T00:00:00Z', NULL, 10817062, 67000, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-23T00:00:00Z', NULL, 10817062, 67100, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-24T00:00:00Z', NULL, 10817062, 67100, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-25T00:00:00Z', NULL, 10817062, 67100, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-26T00:00:00Z', NULL, 10817062, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-27T00:00:00Z', NULL, 10865656, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-28T00:00:00Z', NULL, 10865656, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-29T00:00:00Z', NULL, 10896039, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-04-30T00:00:00Z', NULL, 10896039, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-01T00:00:00Z', NULL, 10903345, 67200, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-02T00:00:00Z', NULL, 10930489, 67300, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-03T00:00:00Z', NULL, 10941192, 67300, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-04T00:00:00Z', NULL, 10949908, 67300, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-05T00:00:00Z', NULL, 10960216, 67300, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('skinz', '2026-05-06T00:00:00Z', NULL, 10960216, 67300, 0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  yt_total_views = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  data_source    = excluded.data_source;

-- ============================================================
-- MYRAKL (30 rows 2026-04-07 ~ 2026-05-06)
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('myrakl', '2026-04-07T00:00:00Z', NULL, 2502904, 5280, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-08T00:00:00Z', NULL, 2509273, 5300, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-09T00:00:00Z', NULL, 2510759, 5320, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-10T00:00:00Z', NULL, 2515820, 5330, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-11T00:00:00Z', NULL, 2522472, 5350, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-12T00:00:00Z', NULL, 2522472, 5370, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-13T00:00:00Z', NULL, 2522472, 5370, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-14T00:00:00Z', NULL, 2522472, 5380, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-15T00:00:00Z', NULL, 2529531, 5380, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-16T00:00:00Z', NULL, 2531912, 5390, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-17T00:00:00Z', NULL, 2531912, 5390, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-18T00:00:00Z', NULL, 2538797, 5420, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-19T00:00:00Z', NULL, 2545725, 5420, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-20T00:00:00Z', NULL, 2549522, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-21T00:00:00Z', NULL, 2549522, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-22T00:00:00Z', NULL, 2561608, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-23T00:00:00Z', NULL, 2561608, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-24T00:00:00Z', NULL, 2580650, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-25T00:00:00Z', NULL, 2580650, 5440, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-26T00:00:00Z', NULL, 2598713, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-27T00:00:00Z', NULL, 2598713, 5430, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-28T00:00:00Z', NULL, 2605136, 5440, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-29T00:00:00Z', NULL, 2605136, 5440, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-04-30T00:00:00Z', NULL, 2605136, 5460, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-01T00:00:00Z', NULL, 2617788, 5470, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-02T00:00:00Z', NULL, 2622666, 5480, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-03T00:00:00Z', NULL, 2645479, 5500, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-04T00:00:00Z', NULL, 2645479, 5500, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-05T00:00:00Z', NULL, 2655407, 5510, 0, 0, 0, 0, 0, 0, 'backfill_estimate'),
  ('myrakl', '2026-05-06T00:00:00Z', NULL, 2655407, 5510, 0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  yt_total_views = COALESCE(excluded.yt_total_views, agg_summary.yt_total_views),
  data_source    = excluded.data_source;
