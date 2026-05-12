-- migrations/0052_debut_window_organicity.sql
--
-- Debut Window Organicity — 데뷔 ±60일 영상 organic vs paid-viral 분석
-- 결과를 두 테이블에 저장. 영상별 drill-down 테이블 + 그룹×버킷 집계 테이블.
--
-- 윈도우 버킷 (5개 비중복):
--   D-60   = days_relative_to_debut ∈ [-60, -31]
--   D-30   = days_relative_to_debut ∈ [-30,  -2]
--   D-Day  = days_relative_to_debut ∈ [ -1,  +1]
--   D+30   = days_relative_to_debut ∈ [ +2, +30]
--   D+60   = days_relative_to_debut ∈ [+31, +60]
--
-- verdict 값: 'organic' | 'suspect' | 'likely_paid' | 'insufficient_data'

CREATE TABLE debut_window_video_organicity (
  video_id               TEXT PRIMARY KEY,
  group_key              TEXT NOT NULL,
  is_short               INTEGER NOT NULL,
  published_at           TEXT NOT NULL,
  days_relative_to_debut INTEGER NOT NULL,
  window_bucket          TEXT NOT NULL,
  view_count             INTEGER,
  like_count             INTEGER,
  comment_count          INTEGER,
  engagement_rate        REAL,
  like_comment_ratio     REAL,
  velocity_ratio         REAL,
  organic_score          INTEGER,
  verdict                TEXT NOT NULL,
  signal_breakdown       TEXT NOT NULL,
  computed_at            TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES youtube_videos(video_id)
);
CREATE INDEX idx_dwo_group_bucket
  ON debut_window_video_organicity(group_key, window_bucket);

CREATE TABLE debut_window_organicity_summary (
  group_key             TEXT NOT NULL,
  window_bucket         TEXT NOT NULL,
  video_count           INTEGER NOT NULL,
  long_form_count       INTEGER NOT NULL,
  short_form_count      INTEGER NOT NULL,
  organic_score_mean    REAL,
  organic_ratio         REAL,
  suspect_ratio         REAL,
  likely_paid_ratio     REAL,
  total_views           INTEGER,
  total_engagement      INTEGER,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (group_key, window_bucket)
);
