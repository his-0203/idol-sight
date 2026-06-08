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


def weekly_flow(levels: list[float], lag: int = 7) -> list[float]:
    """7-day first difference of a cumulative level series (contiguous days).

    Entries without a d-lag counterpart are dropped, so the result has
    len(levels) - lag elements.
    """
    if len(levels) <= lag:
        return []
    return [levels[i] - levels[i - lag] for i in range(lag, len(levels))]


def acceleration(series: list[float], half: int = 14) -> float:
    """mean(last `half`) − mean(prior `half`). 0.0 when either window empty."""
    recent = series[-half:]
    prior = series[-2 * half:-half]
    if not recent or not prior:
        return 0.0
    return sum(recent) / len(recent) - sum(prior) / len(prior)


CLIMB_THRESHOLD = 0.05   # %/week relative-slope boundary (first-pass)


def classify_direction(rel_slope: float | None, threshold: float = CLIMB_THRESHOLD) -> str:
    if rel_slope is None:
        return "unknown"
    if rel_slope > threshold:
        return "climbing"
    if rel_slope < -threshold:
        return "declining"
    return "plateau"


def classify_accel(accel: float, deadband: float) -> str:
    if accel > deadband:
        return "accelerating"
    if accel < -deadband:
        return "decelerating"
    return "flat"


def incremental_er(daily: list[dict], window: int = 7) -> float | None:
    """Δ(likes+comments)/Δviews over the trailing `window` days.

    Captures engagement quality on *new* reach (anchor-independent). None when
    fewer than 2 points or non-positive Δviews.
    """
    if len(daily) < 2:
        return None
    last = daily[-1]
    base = daily[-1 - window] if len(daily) > window else daily[0]
    d_views = (last.get("yt_total_views") or 0) - (base.get("yt_total_views") or 0)
    if d_views <= 0:
        return None
    d_eng = (
        (last.get("yt_likes_total") or 0) + (last.get("yt_comments_total") or 0)
        - (base.get("yt_likes_total") or 0) - (base.get("yt_comments_total") or 0)
    )
    return d_eng / d_views


ACCEL_DEADBAND_FRAC = 0.02   # |accel| below 2% of |mean recent| → flat

_COMMUNITY_COLS = ("dc_total_posts", "theqoo_posts", "instiz_posts", "twitter_posts")


def _series(daily: list[dict], col: str) -> list[float]:
    return [float(r.get(col) or 0) for r in daily]


def _community_series(daily: list[dict]) -> list[float]:
    return [float(sum((r.get(c) or 0) for c in _COMMUNITY_COLS)) for r in daily]


def _wow(levels: list[float]) -> float | None:
    """(L[-1]-L[-8]) / L[-8] — week-over-week % change of a level series."""
    if len(levels) < 8 or levels[-8] == 0:
        return None
    return (levels[-1] - levels[-8]) / levels[-8]


def _pillar_from_levels(key: str, levels: list[float], invert: bool = False) -> dict:
    """Cumulative pillar: trajectory on the weekly-flow series."""
    flows = weekly_flow(levels, lag=7)
    rs = relative_slope(flows, window_days=28)
    if rs is not None and invert:
        rs = -rs
    acc = acceleration(flows, half=14)
    if invert:
        acc = -acc
    recent_mean = abs(sum(flows[-14:]) / len(flows[-14:])) if flows[-14:] else 0.0
    deadband = max(recent_mean * ACCEL_DEADBAND_FRAC, 1e-9)
    return {
        "key": key,
        "level": levels[-1] if levels else None,
        "wow_growth": _wow(levels),
        "slope_4w": rs,
        "accel": acc,
        "direction": classify_direction(rs),
        "accel_dir": classify_accel(acc, deadband),
    }


def _pillar_from_values(key: str, values: list[float], invert: bool = False) -> dict:
    """Ratio/level pillar: trajectory on the value series itself."""
    rs = relative_slope(values, window_days=28)
    if rs is not None and invert:
        rs = -rs
    acc = acceleration(values, half=14)
    if invert:
        acc = -acc
    recent_mean = abs(sum(values[-14:]) / len(values[-14:])) if values[-14:] else 0.0
    deadband = max(recent_mean * ACCEL_DEADBAND_FRAC, 1e-9)
    return {
        "key": key,
        "level": values[-1] if values else None,
        "wow_growth": (values[-1] - values[-8]) if len(values) >= 8 else None,
        "slope_4w": rs,
        "accel": acc,
        "direction": classify_direction(rs),
        "accel_dir": classify_accel(acc, deadband),
    }


def compute_pillars(daily: list[dict]) -> list[dict]:
    """Four trajectory pillars from a KST-daily-resampled series.

    sentiment uses invert=True so 'climbing' always means *healthier* (falling
    negative_ratio), keeping direction semantics uniform across pillars.
    """
    er_series = []
    for i in range(len(daily)):
        er = incremental_er(daily[: i + 1], window=7)
        er_series.append(er if er is not None else 0.0)
    return [
        _pillar_from_levels("reach", _series(daily, "yt_subscribers")),
        _pillar_from_values("engagement", er_series),
        _pillar_from_levels("community", _community_series(daily)),
        _pillar_from_values("sentiment", _series(daily, "negative_ratio"), invert=True),
    ]


PILLAR_WEIGHTS = {"reach": 0.4, "engagement": 0.3, "community": 0.2, "sentiment": 0.1}

_DIR_SCORE = {"climbing": 1, "plateau": 0, "declining": -1, "unknown": 0}
_ACCEL_SCORE = {"accelerating": 1, "flat": 0, "decelerating": -1}


def synthesize_posture(pillars: list[dict]) -> tuple[str, str | None]:
    """Weighted direction → 상승/정체/하락, weighted accel → 가속/감속.
    weakest = pillar with the lowest (direction + accel) combined score.
    """
    dir_sum = sum(PILLAR_WEIGHTS[p["key"]] * _DIR_SCORE[p["direction"]] for p in pillars)
    acc_sum = sum(PILLAR_WEIGHTS[p["key"]] * _ACCEL_SCORE[p["accel_dir"]] for p in pillars)

    if dir_sum > 0.15:
        direction = "상승"
    elif dir_sum < -0.15:
        direction = "하락"
    else:
        direction = "정체"

    accel = "가속" if acc_sum > 0.15 else "감속" if acc_sum < -0.15 else None

    if direction == "정체":
        label = "정체"
    elif direction == "상승":
        label = "상승·가속" if accel == "가속" else "상승·감속(정점 징후)" if accel == "감속" else "상승"
    else:
        label = "하락·가속(악화)" if accel == "가속" else "하락·감속" if accel == "감속" else "하락"

    weakest = min(
        pillars,
        key=lambda p: _DIR_SCORE[p["direction"]] + _ACCEL_SCORE[p["accel_dir"]],
    )["key"]
    return label, weakest


MIN_HISTORY_DAYS = 14


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_FETCH_SQL = """
SELECT group_key, snapshot_at,
       yt_subscribers, yt_total_views, yt_likes_total, yt_comments_total,
       dc_total_posts, theqoo_posts, instiz_posts, twitter_posts,
       negative_ratio
FROM agg_summary
ORDER BY group_key, snapshot_at
"""

_CLEAR_SQL = "DELETE FROM group_growth_trajectory"

_UPSERT_SQL = """
INSERT INTO group_growth_trajectory
  (group_key, computed_at, status, history_days,
   posture_label, weakest_pillar, pillars)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key) DO UPDATE SET
  computed_at=excluded.computed_at,
  status=excluded.status,
  history_days=excluded.history_days,
  posture_label=excluded.posture_label,
  weakest_pillar=excluded.weakest_pillar,
  pillars=excluded.pillars
"""


def build_growth_trajectory(client: _Executor) -> CollectionResult:
    """Per-group growth trajectory snapshot from agg_summary history. Full
    DELETE + rebuild so groups dropping below thresholds don't persist."""
    rows = client.execute(_FETCH_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    by_group: dict[str, list[dict]] = {}
    for r in rows:
        by_group.setdefault(r["group_key"], []).append(r)

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [])]
    for group_key, grows in by_group.items():
        daily = resample_daily(grows)
        history_days = len(daily)
        if history_days < MIN_HISTORY_DAYS:
            statements.append((_UPSERT_SQL, [
                group_key, now, "insufficient_history", history_days,
                None, None, "[]",
            ]))
            continue
        pillars = compute_pillars(daily)
        label, weakest = synthesize_posture(pillars)
        statements.append((_UPSERT_SQL, [
            group_key, now, "ok", history_days,
            label, weakest, json.dumps(pillars),
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
