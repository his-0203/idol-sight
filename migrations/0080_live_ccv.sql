-- migrations/0080_live_ccv.sql
-- Live CCV collector (debut-critical). ccv_tracked toggles which groups are
-- sampled; live_ccv_samples is the per-sample time-series (live only).
ALTER TABLE groups ADD COLUMN ccv_tracked INTEGER NOT NULL DEFAULT 0;
UPDATE groups SET ccv_tracked = 1
  WHERE key IN ('miiwan', 'plave', 'owis', 'wegosix');

CREATE TABLE live_ccv_samples (
  video_id            TEXT NOT NULL,
  group_key           TEXT NOT NULL,
  sampled_at          TEXT NOT NULL,   -- ISO8601 UTC
  concurrent_viewers  INTEGER NOT NULL,
  title               TEXT,
  PRIMARY KEY (video_id, sampled_at)
);
CREATE INDEX idx_ccv_group_time ON live_ccv_samples (group_key, sampled_at);
