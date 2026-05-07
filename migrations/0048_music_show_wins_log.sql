-- 0048_music_show_wins_log.sql — 음방 1위 이벤트 로그 + verification 메커니즘.
--
-- 0041 에서 agg_summary.music_show_wins 컬럼만 추가했고 collector 가
-- 미구현 상태였다. 모든 그룹이 NULL/0 을 읽고 있어 RitualVictory
-- 가중치 0.20 이 비어 있다.
--
-- 이 migration 은 collector 로 채울 event-level 로그 테이블을 만든다.
-- agg_summary.music_show_wins 자체는 cli.py 가 in-memory join 패턴
-- (hanteo_weekly → cohort["hanteo_sales"] 와 동일) 으로 채울 예정.
--
-- 데이터 소스: Naver Open API news search → Gemini 2.5 Flash structured
-- extraction. Hallucination 차단을 위해 같은 (group_key, program,
-- episode_date) 조합이 ≥2 개의 별개 url 에서 보도되어야 status=
-- 'confirmed' 로 승격, 1 건이면 status='pending' 으로 review queue 행.
-- agg_summary 합산은 status='confirmed' 만 카운트.
--
-- url_hash UNIQUE 로 같은 기사 중복 추출 차단 + 캐싱: 백필 재실행 시
-- 이미 처리된 url 은 LLM 호출 skip.

CREATE TABLE IF NOT EXISTS music_show_wins_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key       TEXT NOT NULL,
  program         TEXT NOT NULL,
  episode_date    TEXT NOT NULL,
  song_title      TEXT,
  source_url      TEXT NOT NULL,
  url_hash        TEXT NOT NULL UNIQUE,
  snippet         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('confirmed', 'pending', 'rejected')),
  confidence      REAL,
  extracted_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_msw_group_date
  ON music_show_wins_log(group_key, episode_date);

CREATE INDEX IF NOT EXISTS idx_msw_episode_event
  ON music_show_wins_log(program, episode_date, group_key);

CREATE INDEX IF NOT EXISTS idx_msw_status
  ON music_show_wins_log(status);
