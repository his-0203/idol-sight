-- migrations/0106_awareness_adj.sql
--
-- V2.53 Organic Trust Layer — 인지도 신뢰 할인 컬럼 (additive).
-- awareness_score_adj = awareness_score × organic_confidence.
-- category_rank_adj = 보정값 기준 카테고리 순위. 원값 컬럼은 그대로 유지.

ALTER TABLE agg_awareness ADD COLUMN awareness_score_adj REAL;
ALTER TABLE agg_awareness ADD COLUMN organic_confidence REAL;
ALTER TABLE agg_awareness ADD COLUMN category_rank_adj INTEGER;
