-- migrations/0077_weekly_challenges_lifecycle.sql
-- 주간 챌린지 생애주기 추정 필드 (LLM grounding 추정값 — 측정 아님).
--   started_around : 대략 시작 시점 (예: '2026-05-26경')
--   momentum       : 확산 추세 'rising' | 'peaking' | 'declining' | 'unknown'
--   valid_until    : 업로드해도 유효할 대략 기한 (예: '~2026-06-12', '1주 더')
ALTER TABLE weekly_challenges ADD COLUMN started_around TEXT;
ALTER TABLE weekly_challenges ADD COLUMN momentum TEXT;
ALTER TABLE weekly_challenges ADD COLUMN valid_until TEXT;
