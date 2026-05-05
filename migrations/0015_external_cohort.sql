-- 0015_external_cohort.sql — schema + seed for external K-pop newcomer
-- benchmark cohort.
--
-- Why: the operator needs to answer "where are we vs the broader
-- K-pop newcomer market?", not just "where are we vs the other 7
-- virtual idol groups?". The internal 8-group cohort is too small and
-- self-referential to support a real benchmark argument to executives.
-- This migration introduces a parallel, manually-curated table of
-- recent comparable boy groups so the BI can render a side-by-side
-- "live K-pop / 버추얼" comparison.
--
-- Scope:
--   * external_groups holds the roster (~5 seed groups; expand by
--     future migrations or admin tooling).
--   * external_metrics holds time-series snapshots, mirroring
--     agg_summary's shape but with K-pop-relevant signals
--     (Spotify listeners + YouTube subs/views). Manual seed for
--     2026-05-05 with publicly-known approximate numbers; automated
--     collection is future work.
--   * Index on (group_key, snapshot_at) keeps the latest-row lookup
--     in the API endpoint cheap.
--
-- The seed numbers are approximate — they exist so the view has
-- something to render today. Replace with real Spotify Web API +
-- YouTube Data API pulls in a follow-up worker collector.

CREATE TABLE IF NOT EXISTS external_groups (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_kr         TEXT,
  agency          TEXT,
  debut_date      TEXT,
  group_type      TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'virtual' | 'mixed'
  yt_channel_id   TEXT,
  spotify_artist_id TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS external_metrics (
  group_key                  TEXT NOT NULL,
  snapshot_at                TEXT NOT NULL,
  yt_subscribers             INTEGER,
  yt_total_views             INTEGER,
  spotify_monthly_listeners  INTEGER,
  spotify_followers          INTEGER,
  source                     TEXT,  -- 'manual' | 'spotify_api' | 'youtube_api'
  PRIMARY KEY (group_key, snapshot_at),
  FOREIGN KEY (group_key) REFERENCES external_groups(key)
);

CREATE INDEX IF NOT EXISTS idx_external_metrics_group_snap
  ON external_metrics(group_key, snapshot_at DESC);

-- Seed roster — recent boy-group debutees in the same 2023-2024
-- window as our internal cohort. Picked to give MiiWAN (debut 2026-06)
-- a relevant year-of-launch comparison set.
INSERT OR IGNORE INTO external_groups (
  key, name, name_kr, agency, debut_date, group_type, yt_channel_id, notes
) VALUES
  ('riize',       'RIIZE',        '라이즈',      'SM Entertainment',     '2023-09-04', 'live',
   'UCDjE_qgXEeF36mPZBqx9pUg',
   'SM 5세대 보이그룹. 데뷔 첫 해 라디오 활동 + 디지털 싱글 중심.'),
  ('boynextdoor', 'BOYNEXTDOOR',  '보이넥스트도어', 'KOZ Entertainment (HYBE)', '2023-05-30', 'live',
   'UCgL5LAS-WQbDgPv8q1JVE6Q',
   'HYBE 산하 KOZ. ZICO 프로듀싱.'),
  ('zerobaseone', 'ZEROBASEONE',  '제로베이스원', 'WAKEONE',              '2023-07-10', 'live',
   'UCNMoaFebfrI9ywI8rscRPSQ',
   'BOYS PLANET 출신 9인 프로젝트 그룹. 2027년 활동 종료 예정.'),
  ('nctwish',     'NCT WISH',     'NCT 위시',    'SM Entertainment',     '2024-02-21', 'live',
   'UCdq6PXuWfV8s2F-tYhmRmiQ',
   'NCT 시스템의 도쿄 베이스 신세계. 일본·한국 동시 활동.'),
  ('evnne',       'EVNNE',        '이븐',        'Jellyfish Entertainment', '2023-09-18', 'live',
   'UCBCxOEYP8dqibYXtbY1y8FA',
   '아이랜드 시즌2 출신 6인. 컴팩트 멤버 구성.');

-- Seed metrics — single 2026-05-05 manual snapshot using publicly
-- visible YouTube channel subscriber counts (approximate, rounded to
-- 100k). Spotify numbers are placeholders pending API integration.
INSERT OR IGNORE INTO external_metrics (
  group_key, snapshot_at, yt_subscribers, yt_total_views,
  spotify_monthly_listeners, spotify_followers, source
) VALUES
  ('riize',       '2026-05-05T00:00:00Z', 6200000, 1850000000, 7800000, 1900000, 'manual'),
  ('boynextdoor', '2026-05-05T00:00:00Z', 3400000, 950000000,  4500000, 1300000, 'manual'),
  ('zerobaseone', '2026-05-05T00:00:00Z', 3700000, 1100000000, 5100000, 1500000, 'manual'),
  ('nctwish',     '2026-05-05T00:00:00Z', 2100000, 480000000,  2800000, 720000,  'manual'),
  ('evnne',       '2026-05-05T00:00:00Z', 600000,  130000000,  450000,  180000,  'manual');
