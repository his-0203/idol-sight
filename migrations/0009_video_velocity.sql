-- 0009_video_velocity.sql — first-24h view count + viral velocity ratio.
--
-- Trend Researcher's V2 ask: "24h Velocity (신규 영상의 첫 24h 조회수 /
-- 채널 평균)". This is the K-pop industry's standard signal for how
-- hard a comeback hit on day-1 — a 24h ratio of 5x channel average is
-- a viral release; sub-1x is a flop. We can derive it locally because
-- the YouTube collector already snapshots youtube_video_stats every
-- 6h, so a video uploaded at T+0 has stats rows around T+6h, T+12h,
-- T+18h, T+24h.
--
-- We cache two columns on youtube_videos so the UI doesn't have to
-- recompute the percentile every render:
--
--   view_count_24h        — interpolated views ~24h after upload.
--                           NULL when we don't have stats covering
--                           the +24h window yet (very recent uploads,
--                           or videos uploaded before the collector
--                           was running).
--   viral_velocity_ratio  — view_count_24h / channel_mean_24h, where
--                           channel_mean_24h is the average of
--                           view_count_24h across the channel's
--                           non-NULL values. 1.0 = average channel
--                           performance, 5.0 = viral.

ALTER TABLE youtube_videos ADD COLUMN view_count_24h INTEGER;
ALTER TABLE youtube_videos ADD COLUMN viral_velocity_ratio REAL;

CREATE INDEX idx_yt_videos_velocity
  ON youtube_videos(channel_id, viral_velocity_ratio);
