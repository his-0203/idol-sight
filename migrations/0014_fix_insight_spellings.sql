-- 0014_fix_insight_spellings.sql — fix LLM-generated misspellings in
-- the insights table.
--
-- The Gemini-driven weekly briefing emitted 마이래클 (should be
-- 미라클 — MY:RAKL) and 미이완 (should be 미완소년 — MiiWAN). The
-- root cause is the prompt template (PROMPT_WEEKLY) not specifying
-- canonical Korean names; that fix lives in worker code. This
-- migration cleans the historical rows so the operator stops seeing
-- wrong names in the Insights / WeeklyUpdate / MarketOverview cards
-- that read from this table.
--
-- We touch only `title` and `body`. Other columns (scope, type,
-- source_refs_json) don't carry these strings. The REPLACE chain is
-- ordered most-specific → least-specific so 'MY:RAKL · 마이래클' style
-- text replaces cleanly without leaving 'MY:RAKL · ' artifacts.
--
-- Idempotent: re-running the migration on already-fixed rows is a
-- no-op because the wrong forms are gone.

UPDATE insights
   SET title = REPLACE(REPLACE(title, '마이래클', '미라클'), '미이완', '미완소년'),
       body  = REPLACE(REPLACE(body,  '마이래클', '미라클'), '미이완', '미완소년')
 WHERE title LIKE '%마이래클%' OR title LIKE '%미이완%'
    OR body  LIKE '%마이래클%' OR body  LIKE '%미이완%';
