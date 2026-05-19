-- 0059_melon_chart_date.sql — V2.24 daily-only melon collection.
--
-- 동기:
--   V2.23 (migration 0058)은 realtime+daily union으로 (snapshot_at, group_key,
--   song_id) 단위 row를 적재했다. snapshot_at은 "fetch한 UTC 시각"이라
--   "이 row가 어느 날의 차트인가"를 직접 표현하지 않는다.
--
--   V2.24부터 daily 차트만 수집한다 (realtime 제거). 차트는 본질적으로
--   날짜 단위 자산이므로 "어느 날의 차트인가"를 명시할 chart_date 컬럼이
--   필요하다. 백필 시에도 fetch-UTC가 아닌 chart 본래 날짜로 dedup해야
--   한다.
--
--   chart_date는 YYYY-MM-DD (KST 기준). 멜론 일간차트가 D의 KST 00:00~
--   23:59 데이터를 D+1 새벽 ~ 오전에 확정 공시하므로 cron(21:00 UTC =
--   06:00 KST 익일)이 fetch하는 차트는 "어제 KST"의 차트다.
--
-- 변경:
--   1) chart_date TEXT 컬럼 추가 (nullable; CHECK는 백필 후 적용 안 함 —
--      forward-only 신규 row는 collector가 강제).
--   2) 기존 V2.23 row 백필: chart_date = date(snapshot_at).
--      21:00 UTC snapshot은 KST D+1 06:00 = "어제 KST(= D UTC)의 차트"로
--      이 등식이 성립한다. 다른 시각에 fetch된 row가 있다면 부정확할 수
--      있으나 V2.23은 21:00 UTC 단일 cron이라 이 가정이 깨질 일 없다.
--   3) 인덱스 (group_key, chart_date) — 일간 trajectory 쿼리 최적화.
--      (group_key, snapshot_at) 인덱스는 유지 (audit/debug용 시간축).
--
-- 백필 (forward-only 제약 일부 완화):
--   멜론 공식은 dayTime 파라미터를 무시해 직접 백필 불가. 대신 guyso.me
--   아카이브를 통한 1회성 백필 스크립트가 별도 존재 (cli.py:
--   melon-chart-backfill). 그 스크립트도 chart_date를 명시하므로 이 컬럼이
--   필수다.

ALTER TABLE melon_chart_entries
  ADD COLUMN chart_date TEXT;

-- 기존 V2.23 row 백필: snapshot_at 21:00 UTC = KST D+1 06:00 →
--   차트는 D UTC = "어제 KST" 의 일간차트.
UPDATE melon_chart_entries
   SET chart_date = substr(snapshot_at, 1, 10)
 WHERE chart_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_melon_entries_group_chartdate
  ON melon_chart_entries(group_key, chart_date);
