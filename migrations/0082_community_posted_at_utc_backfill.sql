-- 0082_community_posted_at_utc_backfill.sql
-- V2.43.5: community_posts.posted_at was stored as KST values mislabeled UTC —
-- collectors parsed the KST gallery timestamp and appended 'Z' WITHOUT
-- converting, so the frontend's formatKST added another +9h and post times
-- displayed 9 hours late. Collectors now convert KST→UTC on insert; this
-- backfills existing rows by the same -9h shift.
--
-- Safe to apply once: posted_at is set only on INSERT (the collectors'
-- ON CONFLICT updates only `title`), so re-collection won't re-shift these rows.
-- The datetime() guard skips any unparseable value rather than nulling it.
UPDATE community_posts
SET posted_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime(posted_at, '-9 hours'))
WHERE posted_at IS NOT NULL
  AND posted_at != ''
  AND datetime(posted_at) IS NOT NULL;
