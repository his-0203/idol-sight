-- 0055_debut_window_5tier_verdict.sql
--
-- V2.21 (2026-05-13) — verdict 3-tier (organic/suspect/likely_paid) → 5-tier:
--   organic_strong  (≥85)   진초록
--   organic         (70~84) 초록
--   borderline      (55~69) 노랑
--   suspect         (40~54) 주황
--   likely_paid     (<40)   빨강
-- + insufficient_data (별도, view<1000 AND likes+comments<10)
--
-- 영상별 cause tags (배열, JSON) — 의심 원인 자동 분해:
--   viral_real        velocity_coherence=100 (진짜 viral)
--   engagement_weak   engagement_score<40
--   comment_farm      balance_score<60 AND ratio<normal_lo
--   like_farm         balance_score<60 AND ratio>normal_hi
--   paid_burst        velocity_coherence≤20 (view 폭발인데 engagement 죽음)
--
-- video_organicity 테이블: causes 컬럼 추가 (검색·집계 편의).
-- summary 테이블: 5-tier 분포를 위해 organic_strong_ratio, borderline_ratio 추가.
-- 기존 organic_ratio / suspect_ratio / likely_paid_ratio 정의가 V2.21에서 좁아짐
-- (organic_strong 분리, borderline은 suspect와 별도).

ALTER TABLE debut_window_video_organicity
  ADD COLUMN causes TEXT;

ALTER TABLE debut_window_organicity_summary
  ADD COLUMN organic_strong_ratio REAL;

ALTER TABLE debut_window_organicity_summary
  ADD COLUMN borderline_ratio REAL;
