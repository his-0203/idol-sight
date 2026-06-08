"""Growth trajectory analysis (V2.43 Phase 1).

Frame A (self-history) trajectory over raw agg_summary series. No cohort-ref
recompute — operates directly on stored daily levels. Heuristic, not
ground-truth; thresholds are first-pass and calibrated later.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult


def _kst_day(snapshot_at: str) -> str:
    """KST (UTC+9) calendar day of a UTC ISO8601 timestamp, as YYYY-MM-DD."""
    iso = snapshot_at.replace("Z", "+00:00")
    dt = datetime.fromisoformat(iso).astimezone(UTC) + timedelta(hours=9)
    return dt.strftime("%Y-%m-%d")


def resample_daily(rows: list[dict]) -> list[dict]:
    """Collapse multiple same-KST-day snapshots to the latest one per day.

    Input rows must carry 'snapshot_at'. Output rows gain a 'day' key and are
    sorted ascending by day. The row with the max snapshot_at wins each day.
    """
    by_day: dict[str, dict] = {}
    for r in sorted(rows, key=lambda x: x["snapshot_at"]):
        day = _kst_day(r["snapshot_at"])
        enriched = dict(r)
        enriched["day"] = day
        by_day[day] = enriched  # later snapshot_at overwrites
    return [by_day[d] for d in sorted(by_day)]


def _ols_slope(ys: list[float]) -> float:
    """Least-squares slope of ys against x=0,1,2,…  (per-step slope)."""
    n = len(ys)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    return num / den if den else 0.0


def relative_slope(values: list[float], window_days: int = 28) -> float | None:
    """%/week slope over the trailing window, relative to |mean|.

    None when fewer than 2 points or mean is 0 (undefined relative slope).
    """
    w = values[-window_days:]
    if len(w) < 2:
        return None
    mean = sum(w) / len(w)
    if mean == 0:
        return None
    return _ols_slope(w) * 7.0 / abs(mean)
