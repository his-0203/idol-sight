-- 0041_music_show_wins.sql — V2.16 ritual signal: 음방 1위 누적 횟수.
--
-- Health Score §RitualVictory had only two inputs: hanteo_sales (0.70)
-- and naver_total_news (0.30). For corporate-model groups without an
-- album cycle (MY:RAKL / OWIS / B:DAWN / pre-debut MiiWAN), hanteo
-- reads 0 and the _wmean redistribution rule pushed news to 100% of
-- the factor — i.e. naver search hit count alone could carry ritual
-- score to ~15 pts. That was the MY:RAKL ritual-inflation bug.
--
-- V2.16 fix in two parts:
--   1. health_score._wmean now accepts redistribute=False, and the
--      ritual factor opts in. Dead signals stop boosting their
--      neighbors.
--   2. Add an explicit "ritual" signal: cumulative weekly music-show
--      wins (M Countdown / Show Champion / The Show / Music Bank /
--      Inkigayo). New ritual mix becomes:
--        hanteo  0.50
--        news    0.20
--        music   0.30   (this column)
--
-- The collector for music-show wins is NOT shipped in this migration
-- — it's a future P0 (chartline.kr / IDOLCHART / 음악방송 1위 위키).
-- Until the collector lands every group reads NULL/0 here, the
-- cohort-level live_metrics fold-out marks "music_show_wins" dead, and
-- the redistribute=False rule means the missing 0.30 weight just
-- depresses ritual cleanly. Manual seeds (e.g. PLAVE 음악중심 1위
-- 2024-06) can be inserted ahead of the collector.
--
-- Default 0 (not NULL): an explicit zero is the correct semantic for
-- "we believe this group has zero wins this window" once the collector
-- starts running. Pre-collector NULLs in older snapshots are equally
-- fine — _per_group_live treats both as dead.

ALTER TABLE agg_summary ADD COLUMN music_show_wins INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_summary_music_show
  ON agg_summary(group_key, music_show_wins);
