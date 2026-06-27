-- 0096_live_activity.sql — P2a: MiiWAN 찐팬 활동량 지표.
--
-- 동기:
--   live_chat_messages(방송별 raw 채팅, author 완전 채워짐) + youtube_video_stats
--   를 재가공해 (A) 라이브 채팅 measured 지표 + (B) 영상 참여 estimated 지표를
--   산출·저장한다. 신규 수집 0 — 전부 기존 데이터 재가공. MiiWAN 단독(자사 심층).
--
-- loyalty(0084)의 raw→summary 분리 패턴 미러:
--   agg_live_activity         — 방송별 1행(추이), (group_key, video_id) PK.
--   agg_live_activity_summary — 그룹별 1행(카드 헤드라인 + 추정), group_key PK.
--   build_live_activity 가 group_key 범위 full DELETE+rebuild (멱등).

CREATE TABLE IF NOT EXISTS agg_live_activity (
  group_key         TEXT NOT NULL REFERENCES groups(key),
  video_id          TEXT NOT NULL,
  ended_at          TEXT,             -- 방송 종료 시각 ISO8601 (live_chat_reports)
  unique_chatters   INTEGER,          -- COUNT(DISTINCT author), author 비어있지 않은 것
  total_messages    INTEGER,          -- 방송 메시지 총량 (live_chat_messages COUNT)
  msgs_per_chatter  REAL,             -- total_messages / unique_chatters (1자리)
  peak_msgs_per_min INTEGER,          -- offset_ms//60000 분버킷 최대 COUNT (NULL offset 제외)
  returning_rate    REAL,             -- |chatters ∩ 직전방송| / chatters, 첫 방송 NULL
  basis             TEXT NOT NULL,    -- 'scored'|'low_confidence'|'insufficient'
  generated_at      TEXT NOT NULL,
  PRIMARY KEY (group_key, video_id)
);
CREATE INDEX IF NOT EXISTS idx_ala_group ON agg_live_activity (group_key);

CREATE TABLE IF NOT EXISTS agg_live_activity_summary (
  group_key                 TEXT NOT NULL PRIMARY KEY REFERENCES groups(key),
  generated_at              TEXT NOT NULL,
  window_days               INTEGER NOT NULL DEFAULT 56,
  broadcast_count           INTEGER NOT NULL DEFAULT 0,
  -- (A) 윈도우 헤드라인 — 방송별 값의 중앙값.
  median_unique_chatters    INTEGER,
  median_msgs_per_chatter   REAL,
  median_returning_rate     REAL,
  median_peak_msgs_per_min  INTEGER,
  -- (A-rollup) 윈도우 코어팬 — 2개 이상 방송 등장 author.
  core_fan_count            INTEGER,
  core_fan_share            REAL,     -- core_fan_count / 윈도우 고유 챗터
  -- (B) 영상 참여 estimated — 최신 스냅샷 median 기반(추정치, 인간 판단 대체 아님).
  est_engaged_fans          INTEGER,  -- median(likes per video) — 고유 반응 팬 근사
  est_active_core           INTEGER,  -- median(comments per video) — 적극 참여 상한
  view_through              REAL,     -- median(views) / yt_subscribers
  like_rate                 REAL,     -- median(likes/views)
  comment_rate              REAL,     -- median(comments/views)
  basis                     TEXT NOT NULL  -- 'scored'|'low_confidence'|'insufficient'
);
