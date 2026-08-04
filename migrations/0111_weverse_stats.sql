-- migrations/0111_weverse_stats.sql
-- 미완소년 위버스 가입자·디지털 멤버십 일별 스탯. 위버스는 공개 API가
-- 없어 운영자가 구글 시트에 일별 기록 → weverse-sheet collector가 시트
-- 공개 CSV를 읽어 전량 upsert한다(멱등). countries는 시트의 국가별
-- 가입자 열을 JSON으로 보존(UI 미노출, 데이터만 적재).
CREATE TABLE IF NOT EXISTS weverse_stats (
  group_key           TEXT NOT NULL REFERENCES groups(key),
  day                 TEXT NOT NULL,   -- YYYY-MM-DD (시트의 KST 날짜)
  total_members       INTEGER,
  digital_membership  INTEGER,
  countries           TEXT,            -- JSON {"한국": n, ...}
  collected_at        TEXT NOT NULL,
  PRIMARY KEY (group_key, day)
);
