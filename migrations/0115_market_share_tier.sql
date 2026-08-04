-- migrations/0115_market_share_tier.sql
--
-- v3.1(2026-08): 관심 규모 티어. SoV final %는 백분위 합성이라 "점유율"
-- 표현에 부적합(패널 판정: 천장 100/(0.5N)·규모 압축) — 헤드라인 지위를
-- 은퇴하고 90일 조회 플로우의 log 갭 클러스터 티어(1=선두, 최대 3)를
-- 보조 표시한다. % 시계열(cum/mom/final)은 상세·진단·LLM 컨텍스트용으로
-- 계속 산출(보존용 동결). 티어 규칙: 카테고리별 log10 갭 ≥ 0.5 데케이드.
ALTER TABLE agg_market_share ADD COLUMN tier INTEGER;
