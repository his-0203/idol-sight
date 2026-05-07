-- 0049_music_show_extraction_cache.sql — 음방 1위 LLM 호출 캐시.
--
-- music_show_wins_log (0048) 는 win=true 이벤트만 저장하므로 LLM 이
-- "이 기사 win 아님" 으로 판단한 url 은 그쪽에 안 남는다. 그러면 다음
-- 백필 run 에서 같은 url 을 다시 Naver search 가 hit → 다시 LLM 호출
-- 하는 낭비가 발생.
--
-- 이 테이블은 처리한 모든 url 의 url_hash 와 LLM 판단 결과 (has_win)
-- 만 보관. backfill 파이프라인의 filter_cached 단계가 여기서 lookup
-- 해서 이미 처리된 url 은 LLM 호출 자체를 skip.
--
-- has_win=1 인 row 는 music_show_wins_log 와 url_hash 로 join 하면
-- detail (program / group_key / episode_date) 조회 가능.

CREATE TABLE IF NOT EXISTS music_show_extraction_cache (
  url_hash      TEXT PRIMARY KEY,
  has_win       INTEGER NOT NULL DEFAULT 0
                CHECK (has_win IN (0, 1)),
  confidence    REAL,
  extracted_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_msec_extracted_at
  ON music_show_extraction_cache(extracted_at);
