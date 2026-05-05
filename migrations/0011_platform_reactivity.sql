-- 0011_platform_reactivity.sql — per-platform reactivity ratio.
--
-- Trend Researcher's V2 ask: "Cross-Platform Lag" — for each group,
-- which community platform is the *driver* and which is *reactive*?
-- A YouTube comeback that lights up DC within hours but doesn't move
-- TheQoo for 2 days tells us PLAVE's fandom lives on DC; ISEDOL might
-- behave inversely.
--
-- Implementation: for every viral video (viral_velocity_ratio ≥ 2 in
-- the last 30 days), count posts on each platform in the 24h window
-- *after* vs the 24h window *before* the video's published_at. Average
-- the after/before ratio across all viral videos per group. Ratios
-- above ~1.5 → that platform is reactive (driven by YT comebacks);
-- ratios near 1.0 → that platform's tempo is independent of comebacks
-- (likely 365-day fandom chatter).
--
-- We carry these as four columns on agg_summary so the frontend can
-- render the per-group platform-driver fingerprint without a join.
-- Default 1.0 means "no signal yet" so the UI degrades cleanly when a
-- group has no viral videos in the window.

ALTER TABLE agg_summary ADD COLUMN reactivity_dc     REAL DEFAULT 1.0;
ALTER TABLE agg_summary ADD COLUMN reactivity_theqoo REAL DEFAULT 1.0;
ALTER TABLE agg_summary ADD COLUMN reactivity_instiz REAL DEFAULT 1.0;
ALTER TABLE agg_summary ADD COLUMN reactivity_naver  REAL DEFAULT 1.0;
ALTER TABLE agg_summary ADD COLUMN reactivity_sample INTEGER DEFAULT 0;
