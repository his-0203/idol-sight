-- 0008_agg_group_combined.sql — three "combined view" rows per group.
--
-- Anthropologist's V2 finding: ISEDOL/STELLIVE members are far more
-- active on personal channels than on the group channel. We already
-- aggregate member videos into group totals (0003 + youtube collector
-- fan-out), but the result is a single number — we lose the ability
-- to ask "how much of this is the group channel vs the members?",
-- and we lose the ability to fairly compare an N-member confederation
-- against a 5-member corporate group.
--
-- This table stores three views of the same group, all keyed on
-- (group_key, snapshot_at, combined_method):
--
--   group_only — only the group's main channel (yt_channel_id from
--                groups). For PLAVE this is identical to the regular
--                agg_summary; for ISEDOL/STELLIVE it under-counts
--                massively but is the right number for "company-led
--                media" comparisons.
--
--   sum        — group + every active member channel summed straight.
--                This is what 0003+youtube collector currently emits
--                into agg_summary, so this view is the closest to the
--                existing rollup. Members with no solo channel
--                contribute 0.
--
--   weighted   — group_channel × 1.0 + member_channels × 0.7. The
--                0.7 discount roughly accounts for collab double-
--                counting (the same video may surface under multiple
--                channels' search results — the youtube collector
--                already dedupes IDs, but a fan watching a collab on
--                channel B counts as a "fan of A" too only partially).
--
-- Each row also stores the raw composition (group_subs vs member_subs
-- and an active_member_channel_count) so the UI can render a
-- "Group: 1.5% / Members: 98.5%" sub-line without re-querying.
--
-- The three combined views co-exist with agg_summary; this table is
-- additive and existing queries are untouched. The UI renders a
-- toggle (group_only / sum / weighted) that picks which row drives
-- the displayed numbers.

CREATE TABLE agg_group_combined (
  group_key                    TEXT NOT NULL,
  snapshot_at                  TEXT NOT NULL,
  combined_method              TEXT NOT NULL,    -- 'group_only' | 'sum' | 'weighted'
  yt_subscribers_combined      INTEGER NOT NULL DEFAULT 0,
  yt_views_combined            INTEGER NOT NULL DEFAULT 0,
  yt_videos_combined           INTEGER NOT NULL DEFAULT 0,
  group_subs                   INTEGER NOT NULL DEFAULT 0,
  member_subs                  INTEGER NOT NULL DEFAULT 0,
  active_member_channel_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_key, snapshot_at, combined_method)
);

CREATE INDEX idx_group_combined_snap
  ON agg_group_combined(snapshot_at);
CREATE INDEX idx_group_combined_group_method
  ON agg_group_combined(group_key, combined_method);
