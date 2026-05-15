-- migrations/0057_wegosix_reset_null.sql
--
-- V2.22.4 (2026-05-15): WE GO-6 channel reset cleanup.
--
-- Root cause: channel UCd1vuUixEPTfyiBdINt7UWA (위고식스) reset its
-- visible content between 2026-04-27 and 2026-04-28 (mass video
-- unlisting / channel rebrand). Social Blade backfill picked this up
-- correctly — total_views drops from 3,329,786 (D-34) to 14,744 (D-33)
-- and then ramps back to 2,752,754 by 2026-05-08 (D-23), confirmed by
-- live youtube_channel_stats rows.
--
-- DebutCurve impact: the frontend's cumMaxAdjusted logic
-- (DebutCurve.tsx:215-238) carries the pre-reset 3.33M peak forward
-- across the entire post-reset window as a monotone-violation
-- correction, masking the real post-reset ramp on the D-90 / D-180
-- range tabs. The D-30 ~ D+30 tab starts after the peak so it renders
-- correctly — that's the discrepancy the operator observed.
--
-- Decision (user-confirmed): treat pre-reset data as a separate prior
-- activity period unrelated to the current debut countdown. NULL out
-- yt_subscribers / yt_total_views / yt_total_videos on agg_summary
-- and youtube_channel_stats rows dated before the reset. The post-
-- reset ramp then becomes the canonical curve and DebutCurve shows
-- the same shape on every range tab.
--
-- Rows touched: agg_summary 386 wegosix rows + matching channel_stats
-- rows. Idempotent — re-runs just re-set to NULL.

-- 1) agg_summary pre-reset cleanup. data_source is left intact so the
--    rows themselves remain visible (other columns like
--    naver_total_news may still carry meaning), but the YouTube
--    metric columns are wiped.
UPDATE agg_summary
   SET yt_subscribers  = NULL,
       yt_total_views  = NULL,
       yt_total_videos = NULL
 WHERE group_key = 'wegosix'
   AND date(snapshot_at) < '2026-04-28';

-- 2) youtube_channel_stats raw rows. These are the SB-backfilled
--    anchors that feed agg_summary on the next aggregate cron — if we
--    only cleared agg_summary, the next cron's MAX(c.subscribers) /
--    SUM(c.total_views) join would re-populate the pre-reset window
--    from these rows. So they must go too.
DELETE FROM youtube_channel_stats
 WHERE channel_id = 'UCd1vuUixEPTfyiBdINt7UWA'
   AND date(snapshot_at) < '2026-04-28';
