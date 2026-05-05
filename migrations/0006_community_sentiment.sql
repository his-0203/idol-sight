-- 0006_community_sentiment.sql — sentiment polarity tag on community
-- posts plus rolled-up negative ratio in agg_summary.
--
-- Why: the BI currently only sees raw post counts. A spike in DC
-- volume can mean both "fan hype" and "controversy frenzy" — the
-- direction matters more than the magnitude. We classify each post
-- title via Gemini into one of four buckets:
--
--   positive    — fan support, compliment, hype
--   negative    — criticism, complaint
--   controversy — scandal, leak, 논란
--   neutral     — news, info, schedule
--
-- The classification is best-effort and per-title (not full body) so
-- the LLM cost stays bounded. Default NULL = un-classified; older rows
-- and rows the LLM couldn't bucket cleanly stay NULL and don't break
-- downstream queries.
--
-- agg_summary gets a derived ``negative_ratio`` (negative + controversy
-- divided by classified-only count) so the frontend can render a
-- single quick number per group without joining community_posts every
-- request.

ALTER TABLE community_posts ADD COLUMN sentiment TEXT;
ALTER TABLE agg_summary    ADD COLUMN negative_ratio REAL DEFAULT 0;

CREATE INDEX idx_comm_sentiment ON community_posts(group_key, sentiment);
