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
