"""Build per-group daily summary by reading raw_* tables.

Idempotent on (group_key, snapshot_at) — re-running for the same snapshot_at
overwrites. Computes:
- yt_total_videos, yt_total_views, yt_subscribers (from youtube_videos +
  youtube_channel_stats latest row)
- dc_total_posts, theqoo_posts, instiz_posts (from community_posts grouped
  by platform)
- naver_total_news (excluding is_excluded=1)
- controversy_count (from community_posts WHERE sentiment='controversy'
  over the last CONTROVERSY_WINDOW_DAYS by posted_at — NOT cumulative)
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

# Controversy is re-sourced from community_posts (sentiment='controversy')
# over a TRAILING window — not a cumulative all-time count. The downstream
# health_score._controversy_factor = max(0, 1 - max(0, count-2)/10) (V2.54
# noise floor) is raw-count
# based, so a cumulative community tally would grow without bound and pin
# Health (and the crisis alert) to 0 forever. 14d sits at the top of the
# design's 7-14d range: enough signal for a stable cohort-z on the
# deliberately rare 'controversy' label, still bounded.
CONTROVERSY_WINDOW_DAYS = 14


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT = """
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   yt_likes_total, yt_comments_total,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, controversy_count,
   music_show_wins, melon_top100_peak, melon_top100_depth)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  controversy_count=excluded.controversy_count,
  music_show_wins=COALESCE(excluded.music_show_wins, agg_summary.music_show_wins),
  melon_top100_peak=COALESCE(excluded.melon_top100_peak, agg_summary.melon_top100_peak),
  melon_top100_depth=COALESCE(excluded.melon_top100_depth, agg_summary.melon_top100_depth)
""".strip()


def build_agg_summary(client: _Executor, *, snapshot_at: str) -> CollectionResult:
    # All groups touched across any source. yt_views / yt_subs default
    # to None (not 0) so a group that has community/news activity but
    # no youtube_channel_stats row yet writes NULL for those columns —
    # the API forward-fills against the most recent backfill instead
    # of pinning the latest snapshot to a misleading 0.
    counts: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "yt_videos": 0, "yt_views": None, "yt_subs": None,
        "yt_likes": 0, "yt_comments": 0,
        "dc": 0, "theqoo": 0, "instiz": 0,
        "naver": 0, "controversy": 0,
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

    # Controversy count — re-sourced from community_posts sentiment
    # (LLM-classified 'controversy'). WINDOWED to the last
    # CONTROVERSY_WINDOW_DAYS by posted_at so the count measures *current*
    # controversy pressure, not lifetime volume (a cumulative count would
    # grow unbounded and pin _controversy_factor — and Health — to 0).
    # posted_at is UTC (migration 0082); the lexicographic compare against
    # datetime('now', ?) is the same idiom the community alerts use
    # (alerts.rule_model_theft). Rows with NULL posted_at fall outside the
    # window and are excluded — correct: an un-timestamped post can't be
    # placed in the recency window.
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n "
        "FROM community_posts "
        "WHERE sentiment='controversy' "
        "  AND posted_at >= datetime('now', ?) "
        "GROUP BY group_key",
        [f"-{CONTROVERSY_WINDOW_DAYS} days"],
    )
    for r in rows:
        counts[r["group_key"]]["controversy"] = r["n"]

    # YouTube: video count + most-recent video stats (likes + comments)
    # + latest channel-level totals (subscribers + total views), all
    # grouped by group_key. We pick the most-recent stat snapshot per
    # video so we never double-count a video across daily snapshots.
    #
    # Channel-level totals (total_views / subscribers): these are
    # SUMMED across every distinct channel stamped to the group_key —
    # not MAX. For corporate groups (PLAVE: only group_channel) the
    # sum collapses to a single channel and matches the legacy MAX
    # behaviour. For segmentary / confederation groups (ISEDOL,
    # STELLIVE) where members have huge solo channels — also stamped
    # with the group's group_key by the YouTubeCollector member fan-
    # out (see cli._make_collector + collectors/youtube.py) — MAX
    # would pick whichever single channel happens to be largest and
    # silently drop every other. Concretely: ISEDOL group channel
    # ~120K subs; six member channels ~1-2M each; SUM ≈ 8M; MAX ≈ 2M.
    # The dual-entity table agg_group_combined (sum method) already
    # computes this correctly via per-channel iteration; this query
    # is the single-table equivalent so /api/market and Health Score
    # see the same number without a JOIN.
    #
    # The DISTINCT-channel layer is enforced via a sub-aggregate: we
    # pick each (group_key, channel_id) latest snapshot exactly once
    # before summing, otherwise videos-per-channel would multiply the
    # channel's stats.
    #
    # NULL preferred over 0 for channel-stats columns: when a group has
    # no youtube_channel_stats row yet (e.g. wegosix on collector D-1
    # before channel-stats cron runs), the SUM over zero rows returns
    # NULL via the LEFT JOIN — accurate signal "we don't have this
    # data" for the API forward-fill against the latest non-null
    # backfill row. yt_video_stats SUM legitimately defaults to 0 (a
    # group with no indexed videos has zero likes/comments — that's
    # accurate, not a missing-data case).
    rows = client.execute(
        "SELECT v.group_key, COUNT(DISTINCT v.video_id) AS n_videos, "
        "  COALESCE(SUM(s.likes), 0) AS total_likes, "
        "  COALESCE(SUM(s.comments), 0) AS total_comments "
        "FROM youtube_videos v "
        "LEFT JOIN youtube_video_stats s "
        "  ON s.video_id = v.video_id AND s.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_video_stats "
        "    WHERE video_id = v.video_id) "
        "GROUP BY v.group_key"
    )
    for r in rows:
        counts[r["group_key"]]["yt_videos"] = r["n_videos"]
        counts[r["group_key"]]["yt_likes"] = r["total_likes"]
        counts[r["group_key"]]["yt_comments"] = r["total_comments"]

    # Channel-level totals (subs / total_views): one row per distinct
    # (group_key, channel_id), then summed. The inner subquery picks
    # the latest channel_stats snapshot per channel; the outer sum
    # rolls up all channels stamped to the same group_key (group-
    # owned + member solo channels for segmentary/confederation).
    rows = client.execute(
        "SELECT v.group_key, "
        "  SUM(c.subscribers)  AS subscribers, "
        "  SUM(c.total_views)  AS total_views "
        "FROM ("
        "  SELECT DISTINCT group_key, channel_id "
        "  FROM youtube_videos "
        "  WHERE channel_id IS NOT NULL AND channel_id != ''"
        ") v "
        "LEFT JOIN youtube_channel_stats c "
        "  ON c.channel_id = v.channel_id AND c.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_channel_stats "
        "    WHERE channel_id = v.channel_id) "
        "GROUP BY v.group_key"
    )
    for r in rows:
        # views/subs may be None (no channel_stats row at all for any
        # of the group's channels). Pass through — downstream INSERT
        # writes NULL, which the API forward-fills against the latest
        # non-null backfill row.
        counts[r["group_key"]]["yt_views"] = r["total_views"]
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
                c["naver"], c["controversy"],
                # music_show_wins: NULL — collector not shipped (V2.16
                # stub). The COALESCE in _UPSERT preserves any value
                # already in the row from a manual seed, so this UPSERT
                # never clobbers a hand-entered win count.
                None,
                # melon_top100_peak / melon_top100_depth: NULL —
                # written by MelonChartCollector after this aggregate
                # runs. COALESCE in _UPSERT preserves the previous
                # snapshot's values if today's chart fetch hasn't
                # landed yet (avoids a window where the daily aggregate
                # nukes a manual seed or yesterday's UPDATE).
                None,
                None,
            ],
        ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )
