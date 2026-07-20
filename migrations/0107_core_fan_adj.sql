-- migrations/0107_core_fan_adj.sql
--
-- V2.53 Organic Trust Layer — 추정 코어 유료 의심 제외 컬럼 (additive).
-- suspect/likely_paid verdict 영상 제외 후 median. organic_video_count =
-- 제외 후 표본 수. 표본 < 3 이면 basis='insufficient_organic' (adj NULL).

ALTER TABLE agg_core_fan_estimate ADD COLUMN est_engaged_fans_adj INTEGER;
ALTER TABLE agg_core_fan_estimate ADD COLUMN est_active_core_adj INTEGER;
ALTER TABLE agg_core_fan_estimate ADD COLUMN organic_video_count INTEGER;
