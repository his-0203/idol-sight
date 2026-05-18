-- 0058_melon_chart_entries.sql — V2.23 per-song melon TOP 100 history.
--
-- 동기: V2.18/V2.19에서 group-level signal(peak/depth)만 agg_summary에 저장.
-- "PLAVE 6곡 중 어떤 곡이 며칠째 상승/하강 중인가" 같은 곡 단위 trajectory가
-- 필요해 별도 history 테이블 신설. agg_summary는 daily 1행/그룹이므로 곡 단위
-- 정보를 담을 수 없음.
--
-- 컬럼:
--   snapshot_at TEXT      — UTC, 멜론 차트 fetch 시점 (workflow snap)
--   group_key  TEXT       — agg_summary.group_key 정합
--   song_id    TEXT       — melon data-song-no (안정 식별자)
--   song_title TEXT       — 첫 관측 시 곡명. 곡 retitle 시 UPSERT로 갱신.
--   rank       INTEGER    — realtime+daily union 중 최저(best) rank
--   source     TEXT       — 'realtime' | 'daily' | 'both' (어느 차트 진입인지)
--
-- PK = (snapshot_at, group_key, song_id) → 같은 (날, 그룹, 곡) 중복 차단.
-- 같은 곡이 realtime+daily 양쪽에 다른 rank로 떠도 한 행으로 dedup (collector
-- 가 min 적용 + source='both' 부여).
--
-- 인덱스:
--   (group_key, snapshot_at)         — 그룹 상세 페이지의 30일 시계열 쿼리
--   (group_key, song_id, snapshot_at)— 곡 1개의 trajectory 쿼리
--
-- 백필 불가: 과거 차트 row가 melon에 보존되지 않음. 이 마이그레이션 적용
-- 시점부터 forward-only 누적.

CREATE TABLE IF NOT EXISTS melon_chart_entries (
  snapshot_at TEXT    NOT NULL,
  group_key   TEXT    NOT NULL,
  song_id     TEXT    NOT NULL,
  song_title  TEXT    NOT NULL,
  rank        INTEGER NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('realtime','daily','both')),
  PRIMARY KEY (snapshot_at, group_key, song_id)
);

CREATE INDEX IF NOT EXISTS idx_melon_entries_group_day
  ON melon_chart_entries(group_key, snapshot_at);

CREATE INDEX IF NOT EXISTS idx_melon_entries_song
  ON melon_chart_entries(group_key, song_id, snapshot_at);
