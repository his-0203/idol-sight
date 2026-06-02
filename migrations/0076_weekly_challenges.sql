-- migrations/0076_weekly_challenges.sql
-- 주간 바이럴 챌린지 리스트업 (설계: docs/superpowers/specs/2026-06-02-weekly-viral-challenges-design.md)
-- challenge-scan 잡이 week_start(KST 월요일) 단위로 멱등 교체(DELETE→INSERT).
CREATE TABLE weekly_challenges (
  week_start         TEXT NOT NULL,
  rank               INTEGER NOT NULL,
  name               TEXT NOT NULL,
  tag                TEXT NOT NULL,          -- 'kpop' | 'general'
  description        TEXT,
  origin             TEXT,
  hashtags           TEXT,                   -- JSON 배열
  example_video_ids  TEXT,                   -- JSON 배열 (YouTube video_id)
  yt_recent_shorts   INTEGER,                -- 최근 7일 매칭 샘플 수 (≤50, NULL=미측정)
  yt_total_views     INTEGER,               -- 샘플 합산 조회수 (NULL=미측정)
  miiwan_fit         TEXT,
  source_urls        TEXT,                   -- JSON 배열 (발굴 근거)
  confidence         TEXT,                   -- 'high' | 'medium' | 'low'
  generated_at       TEXT NOT NULL,
  PRIMARY KEY (week_start, rank)
);
CREATE INDEX idx_weekly_challenges_week ON weekly_challenges(week_start);
