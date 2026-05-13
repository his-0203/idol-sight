-- 0054_debut_window_type_split_means.sql
--
-- V2 calibration follow-up (2026-05-13) — debut_window_organicity_summary 확장.
--
-- 신규 컬럼 3개:
--   organic_score_mean_long    : long-form only view-weighted mean (D type filter용)
--   organic_score_mean_short   : shorts only view-weighted mean   (D type filter용)
--   organic_score_mean_simple  : 전체 simple mean (E view-weighted dominance toggle용)
--
-- 기존 organic_score_mean (전체 view-weighted) 유지 — 기존 API/UI 호환.
--
-- 데이터는 다음 aggregate cron이 build_summary로 자동 채움 (재산정 전수 패턴).
-- 백필 직후 일시적으로 새 컬럼 NULL — UI는 NULL fallback 처리.

ALTER TABLE debut_window_organicity_summary
  ADD COLUMN organic_score_mean_long REAL;

ALTER TABLE debut_window_organicity_summary
  ADD COLUMN organic_score_mean_short REAL;

ALTER TABLE debut_window_organicity_summary
  ADD COLUMN organic_score_mean_simple REAL;
