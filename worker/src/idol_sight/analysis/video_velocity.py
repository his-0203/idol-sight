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

    # Pass 2: per-channel mean of view_count_24h, then UPDATE each
    # video's viral_velocity_ratio = its v24 / channel_mean (skipping
    # itself in the mean to avoid self-bias on tiny channels).
    means = client.execute(
        "SELECT channel_id, AVG(view_count_24h) AS m, COUNT(*) AS n "
        "FROM youtube_videos "
        "WHERE view_count_24h IS NOT NULL AND channel_id IS NOT NULL "
        "GROUP BY channel_id"
    )
    mean_by = {
        r["channel_id"]: (float(r.get("m") or 0), int(r.get("n") or 0))
        for r in means
    }
    # We pull the freshly-known v24 values back instead of mutating
    # the dict above, because pass-1 emits UPDATE statements that
    # haven't hit the DB yet — the mean query above reads what's
    # already persisted, which is fine for the *prior* mean. The
    # ratio gets recomputed on the next aggregate cycle once all
    # the new v24 values land.
    rows_with_v24 = client.execute(
        "SELECT video_id, channel_id, view_count_24h "
        "FROM youtube_videos WHERE view_count_24h IS NOT NULL"
    )
    for r in rows_with_v24:
        ch = r.get("channel_id")
        v24 = int(r.get("view_count_24h") or 0)
        m, n = mean_by.get(ch, (0.0, 0))
        if m <= 0 or n < 2:
            continue
        # Leave-one-out mean so a single high-views video doesn't
        # divide itself by itself and report 1.0.
        adjusted_mean = (m * n - v24) / (n - 1) if n > 1 else m
        if adjusted_mean <= 0:
            continue
        ratio = round(v24 / adjusted_mean, 3)
        statements.append((
            "UPDATE youtube_videos SET viral_velocity_ratio=? "
            "WHERE video_id=?",
            [ratio, r["video_id"]],
        ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )


__all__ = ["compute_velocity", "WINDOW_HOURS"]
