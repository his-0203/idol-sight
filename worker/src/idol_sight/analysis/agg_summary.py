"""Build per-group daily summary by reading raw_* tables.

Idempotent on (group_key, snapshot_at) — re-running for the same snapshot_at
overwrites. Computes:
- yt_total_videos, yt_total_views, yt_subscribers (from youtube_videos +
  youtube_channel_stats latest row)
- dc_total_posts, theqoo_posts, instiz_posts (from community_posts grouped
  by platform)
- naver_total_news (excluding is_excluded=1)
- twitter_posts, controversy_count (from twitter_posts; controversy = type)
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT = """
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   yt_likes_total, yt_comments_total,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_total_videos=excluded.yt_total_videos,
  yt_total_views=excluded.yt_total_views,
  yt_subscribers=excluded.yt_subscribers,
  yt_likes_total=excluded.yt_likes_total,
  yt_comments_total=excluded.yt_comments_total,
  dc_total_posts=excluded.dc_total_posts,
  theqoo_posts=excluded.theqoo_posts,
  instiz_posts=excluded.instiz_posts,
  naver_total_news=excluded.naver_total_news,
  twitter_posts=excluded.twitter_posts,
  controversy_count=excluded.controversy_count
""".strip()


def build_agg_summary(client: _Executor, *, snapshot_at: str) -> CollectionResult:
    # All groups touched across any source.
    counts: dict[str, dict[str, int]] = defaultdict(lambda: {
        "yt_videos": 0, "yt_views": 0, "yt_subs": 0,
        "yt_likes": 0, "yt_comments": 0,
        "dc": 0, "theqoo": 0, "instiz": 0,
        "naver": 0, "twitter": 0, "controversy": 0,
    })

    # Community posts by platform.
    rows = client.execute(
        "SELECT group_key, platform, COUNT(*) AS n "
        "FROM community_posts GROUP BY group_key, platform"
    )
    for r in rows:
        gk = r["group_key"]
        if r["platform"] == "dc":
            counts[gk]["dc"] = r["n"]
        elif r["platform"] == "theqoo":
            counts[gk]["theqoo"] = r["n"]
        elif r["platform"] == "instiz":
            counts[gk]["instiz"] = r["n"]

    # Naver articles (relevant only).
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n FROM naver_articles "
        "WHERE COALESCE(is_excluded,0)=0 GROUP BY group_key"
    )
    for r in rows:
        counts[r["group_key"]]["naver"] = r["n"]

    # Twitter posts (count + controversy subset).
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n, "
        "  SUM(CASE WHEN type='controversy' THEN 1 ELSE 0 END) AS controversy_count "
        "FROM twitter_posts GROUP BY group_key"
    )
    for r in rows:
        counts[r["group_key"]]["twitter"] = r["n"]
        counts[r["group_key"]]["controversy"] = r.get("controversy_count") or 0

    # YouTube: video count + most-recent video stats (views + likes +
    # comments) + latest channel subscriber count, all grouped by
    # group_key. We pick the most-recent stat snapshot per video so we
    # never double-count a video across daily snapshots, and we pick the
    # most-recent channel snapshot per (group, channel) so subscriber
    # counts are current.
    rows = client.execute(
        "SELECT v.group_key, COUNT(DISTINCT v.video_id) AS n_videos, "
        "  COALESCE(SUM(s.views), 0) AS total_views, "
        "  COALESCE(SUM(s.likes), 0) AS total_likes, "
        "  COALESCE(SUM(s.comments), 0) AS total_comments, "
        "  COALESCE(MAX(c.subscribers), 0) AS subscribers "
        "FROM youtube_videos v "
        "LEFT JOIN youtube_video_stats s "
        "  ON s.video_id = v.video_id AND s.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_video_stats "
        "    WHERE video_id = v.video_id) "
        "LEFT JOIN youtube_channel_stats c "
        "  ON c.channel_id = v.channel_id AND c.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_channel_stats "
        "    WHERE channel_id = v.channel_id) "
        "GROUP BY v.group_key"
    )
    for r in rows:
        counts[r["group_key"]]["yt_videos"] = r["n_videos"]
        counts[r["group_key"]]["yt_views"] = r["total_views"]
        counts[r["group_key"]]["yt_likes"] = r["total_likes"]
        counts[r["group_key"]]["yt_comments"] = r["total_comments"]
        counts[r["group_key"]]["yt_subs"] = r["subscribers"]

    statements: list[tuple[str, list[Any]]] = []
    for gk, c in counts.items():
        statements.append((
            _UPSERT,
            [
                gk, snapshot_at,
                c["yt_videos"], c["yt_views"], c["yt_subs"],
                c["yt_likes"], c["yt_comments"],
                c["dc"], c["theqoo"], c["instiz"],
                c["naver"], c["twitter"], c["controversy"],
            ],
        ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )
