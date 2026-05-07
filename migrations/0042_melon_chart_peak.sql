-- 0042_melon_chart_peak.sql — V2.18 ritual signal: 멜론 TOP 100 최고 순위.
--
-- D-tier 그룹간 변별력 회복용. V2.17 적용 후 SKINZ/OWIS/MY:RAKL/B:DAWN
-- 점수 spread가 0.5pt 안 (2.1~2.6)으로 좁아 시각적 변별 어려움. 시장
-- 컨센서스가 D-tier 그룹을 가르는 1차 근거는 한터(대부분 0) / 음방
-- (대부분 0) / 영문 brand spelling 영향 받는 naver news가 아니라 **음원
-- 차트 진입 여부**라는 판단.
--
-- 컬럼 정의:
--   melon_top100_peak INTEGER NULL
--     - 1~100: 진입 시 최고 순위 (lower=better)
--     - NULL: 미진입 또는 미수집
--     - 0/>100: invalid (per_group_live가 dead로 처리)
--
-- ritual factor 산식 (V2.18):
--   hanteo  0.50
--   news    0.10
--   music   0.20
--   chart   0.20  (this column → chart_n = (101 - peak) / 100)
--
-- collector 미구현 (V2.18 stub). 다음 후보:
--   - melon.com/chart/index.htm (TOP 100, hourly snapshot 가능)
--   - circlechart.kr (가온, weekly delay)
--   - genie/bugs/flo는 시장 점유율 작아 후순위
-- 사용자 운영자가 manual seed (UPDATE agg_summary SET melon_top100_peak=N
-- WHERE group_key='X' AND snapshot_at='Y')로 시작.

ALTER TABLE agg_summary ADD COLUMN melon_top100_peak INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_summary_melon_chart
  ON agg_summary(group_key, melon_top100_peak)
  WHERE melon_top100_peak IS NOT NULL;
