-- 0004_agg_summary_engagement.sql — add likes/comments aggregates to
-- agg_summary so the Health Score can compute a real engagement rate
-- ((likes + 5·comments) / views) instead of the proxy "top10 average
-- views" which only correlated with channel size.
--
-- Why these two columns: the YouTube Data API already returns likeCount
-- and commentCount on every video stats snapshot, so the data is sitting
-- in youtube_video_stats — we just never rolled it up. The build SQL in
-- analysis/agg_summary.py picks the most-recent stat row per video and
-- sums them per group_key (matching how yt_total_views is computed).
--
-- Defaults to 0 so existing rows remain valid; the next agg_summary
-- rebuild will fill real values.

ALTER TABLE agg_summary ADD COLUMN yt_likes_total    INTEGER DEFAULT 0;
ALTER TABLE agg_summary ADD COLUMN yt_comments_total INTEGER DEFAULT 0;
