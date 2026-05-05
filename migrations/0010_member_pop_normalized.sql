-- 0010_member_pop_normalized.sql — Pareto ratios + N-normalized HHI.
--
-- Analytics Reporter §A-3 caught a structural bug in the v1 evenness
-- metric: with N evenly-spread members, HHI = 1/N → evenness = 1 - 1/N
-- depends on N (5 members tops at 0.8, 10 members at 0.9). V2.5
-- adds a *normalized* HHI rescaled to [0, 1] regardless of group
-- size, plus the more-intuitive top1/top3 share Pareto ratios.

ALTER TABLE agg_member_pop_meta ADD COLUMN hhi_norm    REAL;
ALTER TABLE agg_member_pop_meta ADD COLUMN top1_share  REAL;
ALTER TABLE agg_member_pop_meta ADD COLUMN top3_share  REAL;
