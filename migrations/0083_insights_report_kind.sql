-- 0083_insights_report_kind.sql — 주 2회 weekly 보고(수=중간점검 / 일=결산).
--
-- 동기:
--   analyze-weekly 를 주 2회로 늘리면서 수요일 중간점검(이번 주 일~수, 미완결)과
--   일요일 결산(직전 완결 일~토)이 같은 week_start 를 공유한다. report_kind 로
--   둘을 구분 보존한다. generate_weekly 의 per-week DELETE 도 kind 스코프로
--   바뀌어(WHERE week_start=? AND report_kind=?) 두 보고가 공존한다.
--
-- 기존 행: DEFAULT 'final' 로 자동 백필 (과거 보고는 전부 완결주 결산이었다).
ALTER TABLE insights ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'final';
