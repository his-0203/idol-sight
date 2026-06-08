-- 0081_group_growth_trajectory.sql
-- V2.43: per-group growth trajectory snapshot (one row per group, full
-- DELETE + rebuild each aggregate cron). pillars is a JSON array of
-- {key, level, wow_growth, slope_4w, accel, direction, accel_dir}.
CREATE TABLE IF NOT EXISTS group_growth_trajectory (
  group_key      TEXT PRIMARY KEY,
  computed_at    TEXT NOT NULL,
  status         TEXT NOT NULL,        -- 'ok' | 'insufficient_history'
  history_days   INTEGER NOT NULL,
  posture_label  TEXT,                 -- NULL when insufficient
  weakest_pillar TEXT,                 -- NULL when insufficient
  pillars        TEXT NOT NULL DEFAULT '[]'
);
