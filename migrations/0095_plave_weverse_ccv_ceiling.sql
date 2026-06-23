-- 0095: PLAVE Weverse 천장 CCV — 충성도 floor/ceiling 모델 (V2.52).
--
-- live_ccv_samples 는 YouTube concurrentViewers 만 수집한다. PLAVE 는 라이브
-- 동시 시청자의 상당 비중이 Weverse 로 빠져 YouTube-only CCV(=floor)가 실제
-- 동시 시청자를 구조적으로 과소집계한다. 운영자 추정: Weverse 포함 시 10만~20만.
--
-- floor(YouTube 실측)는 자기 페이지 1차 표시·실데이터로 유지하고, ceiling
-- (Weverse 포함 단일 추정치 = 10~20만 평균 = 150,000)은 그룹 간 비교(Health
-- Intimacy) + 카드의 "비교 기준" 라인에만 쓴다. ceiling 은 flat 추정이라
-- 방송별 분해 없이 ceiling/구독자 1회 산출한다.
--
-- 변경 (2):
--   (1) groups.ccv_ceiling_estimate — 운영자 설정 천장 추정치. plave=150000,
--       나머지 NULL. 후속으로 ISEDOL/STELLIVE(SOOP/치지직) 확장 가능.
--   (2) agg_fan_loyalty 에 ceiling 산출 3컬럼. build_fan_loyalty 가 채운다
--       (다음 aggregate cron 재집계, 백필 불필요). 기존 행은 채워지기 전까지 NULL.

ALTER TABLE groups ADD COLUMN ccv_ceiling_estimate INTEGER;
UPDATE groups SET ccv_ceiling_estimate=150000 WHERE key='plave';

ALTER TABLE agg_fan_loyalty ADD COLUMN conversion_rate_ceiling REAL;
ALTER TABLE agg_fan_loyalty ADD COLUMN score_ceiling REAL;
ALTER TABLE agg_fan_loyalty ADD COLUMN ccv_ceiling INTEGER;
