-- migrations/0039_insights_ai_comment.sql
--
-- WeeklyUpdate / Insights / MiiWANBriefing 카드에 AI 한 줄 코멘트
-- (ai_comment) 슬롯을 정식 도입한다. Frontend 는 직전 PR 에서
-- 옵셔널 슬롯을 미리 비워뒀고 (`MiiWANBriefing.tsx`, `WeeklyUpdate.tsx`,
-- `Insights.tsx`), 이 마이그레이션은 LLM 응답을 INSERT 받기 위한
-- 백엔드 컬럼만 추가한다.
--
-- 의미: ai_comment 는 본문(body)의 의역이 아니라 운영자 관점의
-- 함의/시사점 한 문장 (60자 이내). LLM 이 채우지 못한 행은 NULL.
-- nullable 로 두는 이유:
--   1) 기존 행(=마이그레이션 적용 직후 모든 행)은 채울 방법이 없음.
--   2) Gemini structured output 의 `required` 에서 빼서, 모델이
--      가끔 키를 떨어뜨려도 INSERT 가 실패하지 않도록.

ALTER TABLE insights ADD COLUMN ai_comment TEXT;
