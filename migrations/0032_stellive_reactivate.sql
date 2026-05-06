-- migrations/0032_stellive_reactivate.sql
--
-- Re-enable STELLIVE in MarketOverview cards (사용자 정정 2026-05-06).
-- V2.11 에서 사용자 명시 요청으로 is_active=0 처리됐던 건을, 다시
-- 활성화하되 DebutCurve 차트에서는 별도로 제외 (group_model =
-- 'confederation' 자동 필터, debut-curve.ts).
--
-- 의도: confederation 모델은 우산형 산하 멤버 그룹마다 데뷔일이
-- 다른 구조라 단일 debut_date 정렬 곡선 의미 없음. 다만 시장 점유율,
-- 헬스 스코어, 시장 인사이트 같은 '현재 상태' 비교에는 정상 포함.

UPDATE groups
   SET is_active = 1
 WHERE key = 'stellive';
