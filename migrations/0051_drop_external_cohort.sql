-- 0051_drop_external_cohort.sql — remove external-cohort feature.
--
-- Why: the external-cohort collector (added in 0015) was hand-curated
-- with five YouTube channel IDs (RIIZE / BOYNEXTDOOR / ZEROBASEONE /
-- NCT WISH / EVNNE) that all turned out to be invalid. The
-- ``channels.list`` API silently returns 200 + empty ``items[]`` for
-- bad IDs, which produced 0 INSERT statements every run, and the CLI
-- entry point exits 1 when no statements are emitted — so the workflow
-- has been red since the day it was introduced (4 consecutive failures
-- 2026-05-06 → 05-09).
--
-- The feature was already de-scoped from health-score REF computation
-- in V2.17 (frontend HealthSpec note: "external cohort 머지 미사용"),
-- and there are no remaining frontend consumers of /api/external-cohort
-- (the api.ts ``externalCohort()`` helper has zero callers). The
-- tables, the API endpoint, the worker collector, the CLI command,
-- and the GitHub Action are all being removed in the same change set;
-- this migration drops the schema so the D1 database matches.
--
-- Manually-seeded snapshot rows (2026-05-05 placeholders) are
-- discarded with the table — they were approximate placeholders and
-- have no downstream consumer.

DROP INDEX IF EXISTS idx_external_metrics_group_snap;
DROP TABLE IF EXISTS external_metrics;
DROP TABLE IF EXISTS external_groups;
