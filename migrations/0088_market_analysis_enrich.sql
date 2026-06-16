-- 0088: 시장 분석 데이터 보강 (사용자 피드백 R5 #1·#3·#4).
--
--   #1 watch_minutes  — 절대 시청시간(분). 비율 지표의 분모 = 표본 게이트.
--                       데뷔 초기 소표본 국가를 절대량으로 거른다.
--   #3 organic_share  — 검색+추천(오가닉) 트래픽 비중. 외부/공유(바이럴)와
--                       구분 → 자생 수요 vs 일시 유입 판별. best-effort라 NULL 가능.
--   #4 goods_preorder — 굿즈 예판/위시리스트 by 국가·멤버. 지불의향의 유일한
--                       hard signal. 자동 소스 없음 → 수동/커머스 연동으로 적재.

ALTER TABLE agg_youtube_analytics_country ADD COLUMN watch_minutes INTEGER;
ALTER TABLE agg_youtube_analytics_country ADD COLUMN organic_share REAL;

CREATE TABLE IF NOT EXISTS goods_preorder (
  group_key   TEXT,
  country     TEXT,             -- ISO alpha-2
  member_id   INTEGER,          -- NULL = 그룹 전체(멤버 무관) 예판
  count       INTEGER,          -- 예판/위시리스트 등록 수
  source      TEXT,             -- 'weverse' | 'self_mall' | 'survey' | 'manual'
  recorded_at TEXT,
  PRIMARY KEY (group_key, country, member_id, source, recorded_at)
);
