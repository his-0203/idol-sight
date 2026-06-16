-- migrations/0090_live_chat.sql
-- 라이브 채팅 종료-후 수집·분류. live_chat_messages 는 방송별 raw 채팅(재분석
-- 원천), live_chat_reports 는 방송 1건당 대표 멘트+비율 추정 리포트.
-- video_id 가 live_chat_reports 에 있으면 "처리 완료" → 멱등·재시도 제어.

CREATE TABLE IF NOT EXISTS live_chat_messages (
  video_id   TEXT NOT NULL,
  group_key  TEXT NOT NULL REFERENCES groups(key),
  msg_id     TEXT NOT NULL,        -- YouTube chat item id
  offset_ms  INTEGER,             -- videoOffsetTimeMsec (방송 시작 후 경과 ms)
  author     TEXT,
  message    TEXT NOT NULL,
  PRIMARY KEY (video_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_lcm_video ON live_chat_messages (video_id);

CREATE TABLE IF NOT EXISTS live_chat_reports (
  video_id       TEXT PRIMARY KEY,
  group_key      TEXT NOT NULL REFERENCES groups(key),
  title          TEXT,
  ended_at       TEXT,             -- actualEndTime ISO8601
  generated_at   TEXT NOT NULL,    -- 리포트 생성 시각 ISO8601 UTC
  total_messages INTEGER NOT NULL, -- 긁어온 전체 건수
  sampled        INTEGER NOT NULL, -- LLM 에 넣은 표본 수
  positive_ratio REAL,
  negative_ratio REAL,
  report_json    TEXT NOT NULL
);
