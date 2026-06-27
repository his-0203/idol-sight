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
stat rows around T+6/12/18/24/30h. We take the two snapshots that
*bracket* the +24h mark — the closest one at/before it and the closest
one at/after it, each within ``WINDOW_HOURS`` — and **linearly
interpolate by time** to estimate views at exactly +24h. When only one
side exists (a snapshot was skipped, or the video is too fresh/old to be
bracketed) we fall back to that single raw value and treat the estimate
as low-confidence.

Cached columns on ``youtube_videos``:
  - view_count_24h        — time-interpolated views at ~24h after upload
                            (raw single-snapshot fallback when the +24h
                            mark can't be bracketed; see _interpolate_v24)
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


def _interpolate_v24(
    rows: list[dict[str, Any]],
) -> tuple[int, bool] | None:
    """Estimate a video's view count at exactly +24h from the snapshots that
    bracket that mark.

    ``rows`` carry ``views`` and ``offset_days`` = julianday(snapshot_at) -
    (julianday(published_at) + 1.0), i.e. the snapshot's signed distance from
    the +24h target in days (negative = before the mark, positive = after).

    Returns ``(v24, interpolated)``:
      - both sides present  → time-weighted linear interpolation to the +24h
        mark, ``interpolated=True``;
      - only one side       → that raw value as a fallback,
        ``interpolated=False`` (low confidence — a snapshot was skipped or the
        video can't be bracketed);
      - no usable snapshot   → ``None`` (caller skips the video).

    NOTE: the flag is persisted to ``view_count_24h_interpolated`` on
    ``youtube_videos`` (migration 0098). 1=보간 성공(양측 bracket),
    0=단측 raw 폴백(저신뢰), NULL=미산정.
    """
    before: tuple[int, float] | None = None  # closest snapshot at/before +24h
    after: tuple[int, float] | None = None   # closest snapshot at/after  +24h
    for r in rows:
        views = r.get("views")
        off = r.get("offset_days")
        if views is None or off is None:
            continue
        views, off = int(views), float(off)
        if off <= 0.0 and (before is None or off > before[1]):
            before = (views, off)
        if off >= 0.0 and (after is None or off < after[1]):
            after = (views, off)
    if before is not None and after is not None:
        v_b, o_b = before
        v_a, o_a = after
        span = o_a - o_b
        if span <= 0.0:                  # a single snapshot sat on the mark
            return v_b, True
        # Fraction of the way from the before-snapshot to the after-snapshot
        # at which the +24h mark (offset 0) falls.
        w = (0.0 - o_b) / span
        return int(round(v_b + (v_a - v_b) * w)), True
    if before is not None:
        return before[0], False
    if after is not None:
        return after[0], False
    return None


def compute_velocity(client: _Executor) -> CollectionResult:
    """Walk every video published within the last 30 days, estimate its
    +24h view count by interpolating the bracketing stats snapshots, and
    emit one UPDATE per video. Channel-mean ratios are computed in a
    second pass once view_count_24h is populated for the whole channel."""
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
        # Fetch the two snapshots that bracket published_at + 24h: the closest
        # one at/before the mark and the closest one at/after it, each within
        # ±WINDOW_HOURS. _interpolate_v24 time-weights them (or falls back to a
        # single side). offset_days is the snapshot's signed distance from +24h.
        rows = client.execute(
            "SELECT views, offset_days FROM ("
            "  SELECT views, "
            "         julianday(snapshot_at) - julianday(?) - 1.0 AS offset_days "
            "  FROM youtube_video_stats "
            "  WHERE video_id=? "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 <= 0 "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 >= -? "
            "  ORDER BY offset_days DESC LIMIT 1"
            ") "
            "UNION ALL "
            "SELECT views, offset_days FROM ("
            "  SELECT views, "
            "         julianday(snapshot_at) - julianday(?) - 1.0 AS offset_days "
            "  FROM youtube_video_stats "
            "  WHERE video_id=? "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 > 0 "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 <= ? "
            "  ORDER BY offset_days ASC LIMIT 1"
            ")",
            [
                v["published_at"], vid, v["published_at"], v["published_at"],
                WINDOW_HOURS / 24.0,
                v["published_at"], vid, v["published_at"], v["published_at"],
                WINDOW_HOURS / 24.0,
            ],
        )
        estimate = _interpolate_v24(rows)
        if estimate is None:
            continue
        v24, interpolated = estimate
        statements.append((
            "UPDATE youtube_videos "
            "SET view_count_24h=?, view_count_24h_interpolated=? "
            "WHERE video_id=?",
            [v24, int(interpolated), vid],
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
