-- 0012_relevance_feedback.sql — user-driven relevance labeling + remove
-- the cross-group "버추얼" disambiguation token.
--
-- Why:
--   1) community_posts is the highest-noise data source we surface in the
--      UI (Community/PRRisk views). The collectors' substring-keyword
--      filters can't disambiguate short tokens like "유니" or "린" from
--      the surrounding 일반어, so name-collision posts leak through. We
--      give the operator a "무관 신고" button that flags a row in-place
--      and persists the signal for downstream filter improvement (active-
--      learning loop). Flagged rows are excluded from the BI views by
--      default.
--   2) Every group's context_keywords list contains "버추얼". A token
--      shared by all 8 groups can't disambiguate any of them — it just
--      makes any post mentioning "버추얼" match every group at once.
--      Removing it eliminates the dominant cross-group leakage source
--      identified in the V2.6 audit.
--
-- Forward-compat: flag_reason is free-form so we can later add UI for
--   structured reasons ('cross_group', 'name_collision', 'spam', …).

ALTER TABLE community_posts ADD COLUMN user_flagged_irrelevant INTEGER DEFAULT 0;
ALTER TABLE community_posts ADD COLUMN flagged_at TEXT;
ALTER TABLE community_posts ADD COLUMN flag_reason TEXT;

CREATE INDEX idx_comm_user_flagged ON community_posts(group_key, user_flagged_irrelevant);

-- Strip the "버추얼" token from every group's context_keywords. We only
-- touch rows where it's currently present, so re-running the migration
-- is a no-op. The leading/trailing comma forms cover both "middle of the
-- list" and "tail of the list" positions; the bare-quotes form covers a
-- one-element list (which never happens today but is safe to handle).
UPDATE groups
   SET context_keywords = REPLACE(
                            REPLACE(
                              REPLACE(context_keywords, ',"버추얼"', ''),
                              '"버추얼",', ''
                            ),
                            '"버추얼"', ''
                          )
 WHERE context_keywords LIKE '%"버추얼"%';
