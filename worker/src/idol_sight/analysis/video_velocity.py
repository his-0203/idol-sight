"""24h velocity ratio for newly uploaded videos.

K-pop industry's standard signal for "did this comeback hit": how
many views the video accumulated in its first 24 hours, divided by
the channel's average first-24h count. Ratios:

  >5.0  viral / new high
  2-5   strong release
  1-2   solid
  <1    underperforming

We compute this locally from ``youtube_video_stats`` snapshots. The
collector samples every 6h, so a video uploaded at T+0 typically has
stat rows at T+6/12/18/24h — we pick the row closest to (T+24h) and
interpolate when needed.

Cached columns on ``youtube_videos``:
  - view_count_24h        — interpolated views ~24h after upload
  - viral_velocity_ratio  — view_count_24h / channel_mean_24h

Why cache: the BI dashboard sorts/filters videos by this signal, and
recomputing it across hundreds of videos on every page load would
add seconds to the render. Worker recalculates once per aggregate
cycle and stores the result.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

# How wide a window around the +24h target we accept. With 6h snapshot
# cadence, ±18h gives us 1-2 candidate rows even if one snapshot was
# skipped. Wider windows make the interpolation noisier.
WINDOW_HOURS = 18


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


def compute_velocity(client: _Executor) -> CollectionResult:
    """Walk every video published within the last 30 days, find its
    +24h stats row, and emit one UPDATE per video. Channel-mean
    ratios are computed in a second pass once view_count_24h is
    populated for the whole channel."""
    # Pass 1: per-video first-24h views.
    videos = client.execute(
        "SELECT video_id, channel_id, group_key, published_at "
        "FROM youtube_videos "
        "WHERE published_at IS NOT NULL "
        "  AND published_at >= datetime('now', '-30 days')"
    )
    statements: list[tuple[str, list[Any]]] = []
    # This cycle's freshly-computed v24 per video — fed straight into Pass 2 so
    # ratios reflect the current cycle instead of lagging one (the Pass-1 UPDATEs
    # haven't hit the DB yet when Pass 2 runs).
    fresh: dict[str, tuple[Any, int]] = {}
    for v in videos:
        vid = v["video_id"]
        # Find the stats row whose snapshot_at is closest to
        # published_at + 24h, within ±WINDOW_HOURS of that target.
        rows = client.execute(
            "SELECT views, "
            "  ABS(julianday(snapshot_at) - julianday(?) - 1.0) AS delta "
            "FROM youtube_video_stats "
            "WHERE video_id=? "
            "  AND ABS(julianday(snapshot_at) - julianday(?) - 1.0) <= ? "
            "ORDER BY delta ASC LIMIT 1",
            [v["published_at"], vid, v["published_at"], WINDOW_HOURS / 24.0],
        )
        if not rows:
            continue
        v24 = int(rows[0].get("views") or 0)
        statements.append((
            "UPDATE youtube_videos SET view_count_24h=? WHERE video_id=?",
            [v24, vid],
        ))
        fresh[vid] = (v.get("channel_id"), v24)

    # Pass 2: per-channel mean of view_count_24h, then UPDATE each video's
    # viral_velocity_ratio = its v24 / channel_mean (leave-one-out to avoid
    # self-bias). We merge the persisted v24 values with THIS cycle's fresh ones
    # (fresh wins) so the ratio reflects the current cycle — previously Pass 2
    # read only persisted v24, leaving every ratio one aggregate cycle stale.
    merged: dict[str, tuple[Any, int]] = {}
    for r in client.execute(
        "SELECT video_id, channel_id, view_count_24h "
        "FROM youtube_videos WHERE view_count_24h IS NOT NULL"
    ):
        merged[r["video_id"]] = (
            r.get("channel_id"), int(r.get("view_count_24h") or 0),
        )
    merged.update(fresh)  # this cycle's freshly-computed v24 overrides persisted

    sums: dict[Any, float] = defaultdict(float)
    counts: dict[Any, int] = defaultdict(int)
    for ch, v24 in merged.values():
        if ch is None:
            continue
        sums[ch] += v24
        counts[ch] += 1

    for vid, (ch, v24) in merged.items():
        if ch is None:
            continue
        n = counts[ch]
        if n < 2:
            continue
        # Leave-one-out mean so a single high-views video doesn't divide itself
        # by itself and report 1.0.
        adjusted_mean = (sums[ch] - v24) / (n - 1)
        if adjusted_mean <= 0:
            continue
        ratio = round(v24 / adjusted_mean, 3)
        statements.append((
            "UPDATE youtube_videos SET viral_velocity_ratio=? "
            "WHERE video_id=?",
            [ratio, vid],
        ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )


__all__ = ["compute_velocity", "WINDOW_HOURS"]
