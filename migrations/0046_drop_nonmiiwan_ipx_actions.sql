-- 0046_drop_nonmiiwan_ipx_actions.sql — V2.20.1 cleanup of leaked
-- ipx_action items targeted at non-MiiWAN groups.
--
-- V2.20 prompts.py 강화 (ipx_action scope MUST be 'miiwan') 적용 후
-- 운영자가 대시보드에서 myrakl scope ipx_action 카드를 발견. 원인:
--   1. insights 테이블이 INSERT-only (id auto-increment, no upsert key).
--      매 analyze-weekly 실행마다 append 만 되고 과거 LLM 출력 누적.
--   2. 오늘(2026-05-07) V2.20 프롬프트로 재실행한 analyze-weekly 도
--      LLM이 prompt 위반 사례 1건 emit (Gemini schema 에 enum 강제
--      없어 prompt 만으로는 100% 차단 불가).
--
-- 본 migration 은 모든 시점 누적된 비-MiiWAN ipx_action 을 한 번에
-- 정리. 향후 발생 차단은 별도 commit 의 weekly.py post-validation
-- 가드 (V2.20.1) 에서 처리.
--
-- 보존 대상:
--   - type='ipx_action' AND scope='miiwan'  (의도된 IPX 액션)
--   - type='insight' AND scope=<any>        (일반 인사이트는 비-MiiWAN OK)
--   - type='weekly'  AND scope=<any>        (주간 mover 카드)
--
-- 삭제 대상:
--   - type='ipx_action' AND scope != 'miiwan'  (잘못 부착된 액션 카드)

DELETE FROM insights
WHERE type = 'ipx_action'
  AND (scope IS NULL OR scope != 'miiwan');
