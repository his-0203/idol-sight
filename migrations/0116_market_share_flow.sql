-- migrations/0116_market_share_flow.sql
--
-- v3.1 후속: 티어의 산정 근거인 90일 조회 증분(절대 수치)을 함께 저장.
-- 티어 라벨만으로는 화면에 정량 앵커가 없다는 피드백(2026-08-04) —
-- 이 수치는 백분위 %와 달리 규모를 보존하는 정직한 숫자라 그대로 노출.
ALTER TABLE agg_market_share ADD COLUMN view_flow_90d INTEGER;
