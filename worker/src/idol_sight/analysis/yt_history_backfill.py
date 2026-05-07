"""Synthesize historical agg_summary rows from youtube_videos data.

Why this exists: PLAVE / ISEDOL / STELLIVE debuted in 2021-2023 but
the dashboard only started collecting agg_summary in 2026. The
DebutCurve and D-30 benchmark cards therefore render as empty for
their pre-debut and early-post-debut windows. We can't recover the
historical *channel statistics* (YouTube doesn't expose subscriber
counts on a date axis), but we DO have every video's
``published_at`` and a current view count, so we can faithfully
reconstruct two derived cumulative metrics:

  - ``yt_total_videos`` — exact count of videos with published_at on
    or before each snapshot date. Lossless: if MiiWAN published two
    videos on 2026-04-15, the synthesized row for that date will
    show videos=2 (after that day's drops).

  - ``yt_total_views`` — cumulative SUM of CURRENT view counts for
    those videos. This is an *over*-estimate vs the true historical
    view count (a video published in 2023 has accumulated views
    since then), but the *shape* of the curve — when the channel
    grew, when it stalled — is preserved. Treat absolute values with
    a grain of salt; treat the curve as the truth.

Other agg_summary columns (subscribers, dc/theqoo/instiz posts, news,
twitter, controversy) cannot be backfilled and are written as 0.
The DebutCurve metric selector caps at the columns we can fill, so
the operator never sees a flat-zero curve for those.

Idempotent via ``ON CONFLICT … DO UPDATE … WHERE data_source =
'backfill_estimate'``: re-running the backfill (a) only touches rows
the backfill itself owns (live collector rows are protected by the
WHERE clause), and (b) only fills NULL slots in those rows
(``COALESCE(existing, excluded)``) so non-NULL values from earlier
backfill passes (e.g. Wayback or SocialBlade) survive. Re-running is
safe and re-populates rows that were previously cleared by ad-hoc
data-quality migrations.
"""

from __future__ import annotations

from datetime import date as _date
from datetime import timedelta
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


# Same column order as build_agg_summary INSERTs so a dry-running test
# can compare statements verbatim. Synthetic rows fill non-YT columns
# with 0; the cumulative video & view counts come from the synthesis.
_INSERT_SQL = """
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_total_videos = COALESCE(agg_summary.yt_total_videos, excluded.yt_total_videos),
  yt_total_views  = COALESCE(agg_summary.yt_total_views, excluded.yt_total_views)
WHERE agg_summary.data_source = 'backfill_estimate'
""".strip()


def backfill_yt_history(client: _Executor) -> CollectionResult:
    """Walk youtube_videos chronologically per group, emit one
    agg_summary row per unique publication date with cumulative
    video count + cumulative current-view sum.

    The query joins to youtube_video_stats via a correlated subquery
    that picks the latest known view count per video. Videos whose
    stats row has never been written keep a view contribution of 0,
    which is the correct default — they shouldn't bump cumulative
    views above the truth.
    """
    # Filter to videos uploaded by the GROUP'S main channel only
    # (groups.yt_channel_id). Without this, yt_history walks every
    # video stamped with this group_key, which the YouTube collector
    # also stamps for member solo channels — inflating the cumulative
    # count past the live agg_summary's COUNT(DISTINCT v.video_id)
    # (which DOES count solos but only when production has indexed
    # them, often a smaller subset). The mismatch creates the visible
    # comb pattern when same-day rows from both sources have wildly
    # different values. Restricting to main channel makes both sources
    # consistent: yt_history counts main-only videos, live counts
    # main-only videos (because production's youtube_videos table
    # primarily has main channel content). For ISEDOL/STELLIVE-style
    # segmentary groups this is a meaningful loss (their content IS
    # the member solos), but those groups are excluded from the K-POP
    # cohort comparison anyway and should be tracked via their own
    # group_key='isedol_solo_<member>' if richer data is needed.
    rows = client.execute(
        """
        SELECT v.group_key,
               substr(v.published_at, 1, 10) AS pub_date,
               COALESCE((
                 SELECT s.views
                   FROM youtube_video_stats s
                  WHERE s.video_id = v.video_id
                  ORDER BY s.snapshot_at DESC
                  LIMIT 1
               ), 0) AS views
          FROM youtube_videos v
          JOIN groups g ON g.key = v.group_key
         WHERE v.published_at IS NOT NULL
           AND v.published_at <> ''
           AND v.channel_id = g.yt_channel_id
         ORDER BY v.group_key, v.published_at ASC
        """
    )

    # Bucket into per-group, sorted-by-date streams. The query already
    # orders by group_key, published_at so we just walk it once.
    by_group: dict[str, list[tuple[str, int]]] = {}
    for r in rows:
        date = r.get("pub_date")
        if not date:
            continue
        by_group.setdefault(r["group_key"], []).append(
            (date, int(r.get("views") or 0))
        )

    statements: list[tuple[str, list[Any]]] = []
    for gk, items in by_group.items():
        # Walk videos chronologically, accumulating count + view sum.
        # Per unique date keep only the LAST cumulative value (i.e. the
        # state at end-of-day after all that day's videos drop). This
        # collapses multi-video days into a single agg_summary row.
        per_date: dict[str, tuple[int, int]] = {}
        cum_views = 0
        for cum_videos, (date, views) in enumerate(items, start=1):
            cum_views += views
            per_date[date] = (cum_videos, cum_views)

        # Forward-fill across every calendar day from first publish to
        # last. Without this, dates with no published_at have no row,
        # and the DebutCurve chart sees gaps that span-gap-interpolation
        # paints with non-monotonic curves whenever a different source
        # (Wayback, SocialBlade) has a contemporaneously-correct-but-
        # lower value at one of those gap dates. The forward-filled
        # cumulative is monotonic by construction (max of carried
        # value vs. that day's update), so even mixed with anchors from
        # other sources the chart's max-wins picks a sensible value.
        if per_date:
            sorted_dates = sorted(per_date.keys())
            try:
                first_d = _date.fromisoformat(sorted_dates[0])
                last_d  = _date.fromisoformat(sorted_dates[-1])
            except ValueError:
                first_d = last_d = None
            if first_d and last_d and last_d >= first_d:
                filled: dict[str, tuple[int, int]] = {}
                last_val = per_date[sorted_dates[0]]
                d = first_d
                while d <= last_d:
                    ds = d.isoformat()
                    if ds in per_date:
                        last_val = per_date[ds]
                    filled[ds] = last_val
                    d += timedelta(days=1)
                per_date = filled

        for date, (videos, views) in per_date.items():
            snap = f"{date}T00:00:00Z"
            statements.append((_INSERT_SQL, [gk, snap, videos, views]))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )


__all__ = ["backfill_yt_history"]
