-- 0044_melon_chart_depth.sql — V2.19 ritual signal: 멜론 TOP 100 진입곡 수.
--
-- V2.18 (chart_peak) 운영 첫날 발견: 일간 차트만 fetch하면 PLAVE처럼 팬덤
-- 깊은 그룹의 음원 강도를 systematically underrepresent. PLAVE는 실시간
-- 차트에 6곡 진입(34/73/78/87/90/94) 중인데 일간 차트엔 73위 1곡만.
-- best rank 1개로는 "곡 깊이"를 표현 못 함 — 6곡 진입 그룹과 1곡 진입
-- 그룹 변별 시그널이 필요. (V2.19에서 collector도 realtime+day union으로
-- 변경, 이 컬럼은 union depth 저장).
--
-- 컬럼 정의:
--   melon_top100_depth INTEGER NULL
--     - >0: realtime + day 차트 union (song_id dedup) 기준 진입곡 수
--     - 0: 두 차트 모두 미진입
--     - NULL: 미수집 (collector 미실행 / 둘 다 fetch 실패)
--
-- ritual factor 산식 (V2.19, redistribute=False 유지):
--   hanteo  0.50
--   news    0.10
--   music   0.20
--   chart_peak  0.10  (V2.18 0.20 → 0.10, depth로 절반 양도)
--   chart_depth 0.10  (this column → depth_n = min(depth/5, 1.0))
--
-- depth ref=5 — 5곡 동시 진입 시 saturated. PLAVE 6곡 → 1.0pt. 단곡 진입
-- (예: 신생 그룹 데뷔 직후) → 0.2pt. 5는 강팬덤/장기 활동의 의미 있는
-- ceiling이지, K-pop 메이저 그룹의 흔한 음원 공세(10+곡) 변별이 목적이
-- 아님. 우리 코호트는 D~B-tier가 핵심.

ALTER TABLE agg_summary ADD COLUMN melon_top100_depth INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_summary_melon_depth
  ON agg_summary(group_key, melon_top100_depth)
  WHERE melon_top100_depth IS NOT NULL;
