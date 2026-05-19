-- 0060_melon_chart_type.sql — V2.25 일간 + TOP100 차트 분기 적재.
--
-- 동기:
--   V2.24까지는 "일간차트"만 수집했다. 사용자 요청에 따라 22:00 KST 시점의
--   TOP100 차트도 매일 1회 추가 수집해서 화력 정점(저녁 화력 결산) 데이터를
--   별도 trajectory로 보존한다. 두 데이터를 같은 테이블에 적재하되 chart_type
--   으로 구분.
--
--   chart_type='daily'   — /chart/day/index.htm 06:00 KST 적재 (V2.24 흐름).
--                          fetch 시점에 멜론이 확정한 "어제 KST의 24h 풀집계".
--   chart_type='top100'  — /chart/index.htm 22:00 KST 적재 (V2.25 신규).
--                          fetch 시점의 "24h 누적 50% + 직전 1h 50%" 가중치 차트.
--                          22 KST 시점은 저녁 화력이 가장 잘 반영되는 슬롯.
--
-- PK 변동 없음:
--   (snapshot_at, group_key, song_id) 유지. snapshot_at 시각이 21 UTC (daily) vs
--   13 UTC (top100)로 다르므로 같은 (group_key, song_id)도 충돌하지 않는다.
--   백필 row의 synthetic snapshot_at = "<chart_date>T00:00:00Z"도 다른 시각이라
--   안전.
--
-- 백필:
--   기존 V2.23/V2.24 row는 모두 'daily'로 일괄 표기. V2.23 시절에 만들어진
--   source='realtime'/'both' row도 daily fetch 시점에 적재된 것이므로 chart_type
--   의미상 'daily' 로 분류한다 (source 필드는 historical artifact로 그대로 보존).
--
-- 인덱스:
--   (chart_type, group_key, chart_date) — 탭별 trajectory 쿼리 핵심 경로.
--   기존 (group_key, chart_date) 인덱스(migration 0059)는 chart_type 필터 없이
--   조회할 때 유용해서 유지.

ALTER TABLE melon_chart_entries
  ADD COLUMN chart_type TEXT;

UPDATE melon_chart_entries
   SET chart_type = 'daily'
 WHERE chart_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_melon_entries_type_group_date
  ON melon_chart_entries(chart_type, group_key, chart_date);
