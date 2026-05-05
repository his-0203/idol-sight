"""Build agg_group_combined rows — three combined views per group.

The youtube collector already aggregates member-channel videos into
``agg_summary.yt_total_views``/``yt_subscribers`` (via
``_load_active_groups`` + the per-group ``group_key`` stamping), so the
existing single-number BI is already a "sum" view in spirit. What we
gain by writing this table:

- ``group_only``: separates "company-led media" from "members' personal
  reach". For ISEDOL the company channel is ~120K subs while members
  total ~8M+ — they answer different questions.
- ``weighted``: discounts member contributions to dampen collab double-
  counting and to give a fairer "group identity strength" reading.
  Weight 0.7 is a heuristic — operators can tune later.

Result is one row per (group, snapshot_at, method). Idempotent on the
composite key so re-runs at the same snapshot overwrite cleanly.
"""

from __future__ import annotations

from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

# Member-channel discount for the 'weighted' view. 1.0 = treat member
# channels as equivalent to the group channel; 0.0 = ignore members
# entirely. 0.7 is the recommended starting point — see Anthropologist
# report §C-2.
MEMBER_WEIGHT = 0.7

_UPSERT = """
INSERT INTO agg_group_combined
  (group_key, snapshot_at, combined_method,
   yt_subscribers_combined, yt_views_combined, yt_videos_combined,
   group_subs, member_subs, active_member_channel_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key, snapshot_at, combined_method) DO UPDATE SET
  yt_subscribers_combined=excluded.yt_subscribers_combined,
  yt_views_combined=excluded.yt_views_combined,
  yt_videos_combined=excluded.yt_videos_combined,
  group_subs=excluded.group_subs,
  member_subs=excluded.member_subs,
  active_member_channel_count=excluded.active_member_channel_count
""".strip()


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


def build_agg_group_combined(
    client: _Executor, *, snapshot_at: str,
) -> CollectionResult:
    """Per active group, compute and emit the three combined views.

    Reads:
      - groups (key, yt_channel_id) — group channel ID per group
      - members (group_key, yt_channel_id) — solo-channel members
      - youtube_channel_stats — latest subscribers/total_views per channel
      - youtube_videos — video count per channel
    """
    groups = client.execute(
        "SELECT key, yt_channel_id FROM groups WHERE is_active=1"
    )
    statements: list[tuple[str, list[Any]]] = []

    for g in groups:
        gk = g["key"]
        group_channel = g.get("yt_channel_id")

        member_rows = client.execute(
            "SELECT yt_channel_id FROM members "
            "WHERE group_key=? AND active=1 AND yt_channel_id IS NOT NULL "
            "  AND yt_channel_id != ''",
            [gk],
        )
        member_channels = [m["yt_channel_id"] for m in member_rows
                           if m.get("yt_channel_id")]

        # Fetch latest channel_stats for group + each member channel.
        all_channels = ([group_channel] if group_channel else []) + member_channels
        if not all_channels:
            continue

        # Pull each channel's most-recent youtube_channel_stats row in one
        # query per channel (D1 doesn't support window functions in REST
        # cleanly; the per-channel query is cheap because the index is
        # already on (channel_id, snapshot_at)).
        chan_subs: dict[str, int] = {}
        chan_views: dict[str, int] = {}
        for ch in all_channels:
            r = client.execute(
                "SELECT subscribers, total_views FROM youtube_channel_stats "
                "WHERE channel_id=? "
                "ORDER BY snapshot_at DESC LIMIT 1",
                [ch],
            )
            if r:
                chan_subs[ch] = int(r[0].get("subscribers") or 0)
                chan_views[ch] = int(r[0].get("total_views") or 0)
            else:
                chan_subs[ch] = 0
                chan_views[ch] = 0

        # Video count per channel (cheap from youtube_videos).
        chan_videos: dict[str, int] = {}
        for ch in all_channels:
            r = client.execute(
                "SELECT COUNT(*) AS n FROM youtube_videos WHERE channel_id=?",
                [ch],
            )
            chan_videos[ch] = int(r[0].get("n", 0) if r else 0)

        group_subs   = chan_subs.get(group_channel, 0) if group_channel else 0
        group_views  = chan_views.get(group_channel, 0) if group_channel else 0
        group_videos = chan_videos.get(group_channel, 0) if group_channel else 0
        member_subs   = sum(chan_subs.get(c, 0)   for c in member_channels)
        member_views  = sum(chan_views.get(c, 0)  for c in member_channels)
        member_videos = sum(chan_videos.get(c, 0) for c in member_channels)
        n_members    = len(member_channels)

        for method, subs, views, videos in (
            ("group_only", group_subs, group_views, group_videos),
            ("sum",        group_subs + member_subs,
                           group_views + member_views,
                           group_videos + member_videos),
            ("weighted",   group_subs + int(member_subs * MEMBER_WEIGHT),
                           group_views + int(member_views * MEMBER_WEIGHT),
                           group_videos + int(member_videos * MEMBER_WEIGHT)),
        ):
            statements.append((
                _UPSERT,
                [gk, snapshot_at, method,
                 subs, views, videos,
                 group_subs, member_subs, n_members],
            ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )


__all__ = ["build_agg_group_combined", "MEMBER_WEIGHT"]
