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

__all__ = [
    "resample_daily",
    "relative_slope",
    "weekly_flow",
    "acceleration",
    "classify_direction",
    "classify_accel",
    "incremental_er",
    "community_activity_series",
    "compute_pillars",
    "synthesize_posture",
    "build_growth_trajectory",
    "CLIMB_THRESHOLD",
    "PILLAR_WEIGHTS",
    "MIN_HISTORY_DAYS",
]


def _kst_day(snapshot_at: str) -> str:
    """KST (UTC+9) calendar day of a UTC ISO8601 timestamp, as YYYY-MM-DD."""
    iso = snapshot_at.replace("Z", "+00:00")
    dt = datetime.fromisoformat(iso) + timedelta(hours=9)
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


MIN_DELTA_VIEWS_FOR_ER = 1000   # too few new views → ER ratio explodes (artifact)


def incremental_er(daily: list[dict], window: int = 7) -> float | None:
    """Δ(likes+comments)/Δviews over the trailing `window` days.

    Captures engagement quality on *new* reach (anchor-independent). None when
    fewer than 2 points, or when Δviews is below MIN_DELTA_VIEWS_FOR_ER — a tiny
    (or stale/quantized) view delta makes the ratio explode to implausible values
    (e.g. 86%), so we treat it as no signal. If cumulative likes/comments decrease
    (moderation/correction) d_eng can be negative, yielding a negative ER;
    downstream handles that safely.
    """
    if len(daily) < 2:
        return None
    last = daily[-1]
    base = daily[-1 - window] if len(daily) > window else daily[0]
    d_views = (last.get("yt_total_views") or 0) - (base.get("yt_total_views") or 0)
    if d_views < MIN_DELTA_VIEWS_FOR_ER:
        return None
    d_eng = (
        (last.get("yt_likes_total") or 0) + (last.get("yt_comments_total") or 0)
        - (base.get("yt_likes_total") or 0) - (base.get("yt_comments_total") or 0)
    )
    return d_eng / d_views


ACCEL_DEADBAND_FRAC = 0.02   # |accel| below 2% of |mean recent| → flat

# Calibrated against the live group distribution (2026-06-08 audit).
REACH_NOISE_FLOOR = 0.02         # reach 4-week move < 2% → 유지 (quantized/frozen subs)
MIN_COMMUNITY_VOLUME = 5         # current 7-day posting volume < 5 → too quiet to judge
MIN_COMMUNITY_ACTIVE_DAYS = 14   # < 14 days with any posting → onset/too-short → unknown


def _series(daily: list[dict], col: str) -> list[float]:
    return [float(r.get(col) or 0) for r in daily]


def _shift_day(day: str, delta: int) -> str:
    """Shift a 'YYYY-MM-DD' day string by `delta` days."""
    return (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=delta)).strftime("%Y-%m-%d")


def community_activity_series(
    posts_by_day: dict[str, int], days: list[str], window: int = 7,
) -> list[float]:
    """Trailing `window`-day posting volume aligned to `days` (the resampled
    timeline). ``posts_by_day`` maps a posted_at day ('YYYY-MM-DD') to its post
    count. Each output is the number of posts actually *posted* in the window
    ending at that day — real recent activity, NOT the cumulative all-time count
    (which only ever rises as old/backfilled/supplemental posts accumulate and so
    can't tell a quiet week from a busy one)."""
    return [
        float(sum(posts_by_day.get(_shift_day(d, -k), 0) for k in range(window)))
        for d in days
    ]


def _wow(levels: list[float]) -> float | None:
    """(L[-1]-L[-8]) / L[-8] — week-over-week % change of a level series."""
    if len(levels) < 8 or levels[-8] == 0:
        return None
    return (levels[-1] - levels[-8]) / levels[-8]


def _change_4w(series: list[float], relative: bool) -> float | None:
    """Change over the trailing ~4 weeks (28 days): a relative ratio for
    cumulative-level pillars, an absolute delta for ratio pillars. Falls back to
    the earliest point when history is shorter than 28 days. None if fewer than 2
    points, or (relative) the base is 0. This is the magnitude the UI shows next
    to the 4-week-trend status word, so the two share one horizon and can't read
    as contradictory the way a noisy single-week figure did."""
    if len(series) < 2:
        return None
    base = series[-29] if len(series) >= 29 else series[0]
    if relative:
        return (series[-1] - base) / base if base else None
    return series[-1] - base


COMPARE_THRESHOLD = 0.10   # recent vs prior 7-day change to call it 증가/둔화 (else 유지)


def _compare_direction(
    prev: float | None, recent: float | None,
    invert: bool = False, threshold: float = COMPARE_THRESHOLD,
) -> str:
    """Direction from the SAME 'prev 7d → recent 7d' figures the UI shows, so the
    status word can never contradict the numbers. invert=True flips it so for
    sentiment a falling negative_ratio reads as 'climbing' (healthier)."""
    if prev is None or recent is None:
        return "unknown"
    if abs(prev) < 1e-9:
        if abs(recent) < 1e-9:
            return "plateau"
        delta = 1.0 if recent > 0 else -1.0
    else:
        delta = (recent - prev) / abs(prev)
    if invert:
        delta = -delta
    if delta > threshold:
        return "climbing"
    if delta < -threshold:
        return "declining"
    return "plateau"


def _pillar_from_levels(
    key: str, levels: list[float], invert: bool = False, noise_floor: float | None = None,
) -> dict:
    """Cumulative pillar: trajectory on the weekly-flow series.

    ``noise_floor`` guards against quantized/frozen level data — YouTube rounds
    large-channel subscriber counts, so the series barely moves and
    relative_slope amplifies the residual into a spurious climbing/declining.
    When the real 4-week move is below the floor, the level is effectively flat →
    force 유지 (plateau / flat)."""
    flows = weekly_flow(levels, lag=7)
    rs = relative_slope(flows, window_days=28)
    if rs is not None and invert:
        rs = -rs
    acc = acceleration(flows, half=14)
    if invert:
        acc = -acc
    recent_mean = abs(sum(flows[-14:]) / len(flows[-14:])) if flows[-14:] else 0.0
    deadband = max(recent_mean * ACCEL_DEADBAND_FRAC, 1e-9)
    change = _change_4w(levels, relative=True)
    # prev/recent = adjacent 7-day flows (last week's adds vs this week's). Direction
    # is the comparison of these two so the status WORD always matches the displayed
    # "이전 X → 최근 Y" numbers (never contradicts them).
    prev = flows[-8] if len(flows) >= 8 else None
    recent = flows[-1] if flows else None
    direction = _compare_direction(prev, recent, invert)
    accel_dir = classify_accel(acc, deadband)
    if noise_floor is not None and change is not None and abs(change) < noise_floor:
        direction = "plateau"
        accel_dir = "flat"
    return {
        "key": key,
        "level": levels[-1] if levels else None,
        # wow_growth is a relative ratio (e.g. +0.10 = +10%) for cumulative-level
        # pillars. Consumers must render per pillar type (not the same as ratio pillars).
        "wow_growth": _wow(levels),
        "change_4w": change,
        "prev": prev,
        "recent": recent,
        "slope_4w": rs,
        "accel": acc,
        "direction": direction,
        "accel_dir": accel_dir,
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
    prev = values[-8] if len(values) >= 8 else None
    recent = values[-1] if values else None
    return {
        "key": key,
        "level": values[-1] if values else None,
        # wow_growth is an absolute delta (e.g. ER 3%→5% = +0.02 = +2 pp) for
        # ratio/value pillars — a relative % change would be misleading here.
        # Consumers must render per pillar type (not the same as level pillars).
        "wow_growth": (values[-1] - values[-8]) if len(values) >= 8 else None,
        "change_4w": _change_4w(values, relative=False),
        # prev/recent = the value 7 days ago vs now; direction is their comparison
        # so the status word always matches the displayed "이전 X → 최근 Y".
        "prev": prev,
        "recent": recent,
        "slope_4w": rs,
        "accel": acc,
        "direction": _compare_direction(prev, recent, invert),
        "accel_dir": classify_accel(acc, deadband),
    }


def compute_pillars(daily: list[dict], community_series: list[float]) -> list[dict]:
    """Four trajectory pillars from a KST-daily-resampled series.

    ``community_series`` is the trailing-window posting *volume* (by posted_at,
    via community_activity_series), aligned to ``daily`` — real recent activity,
    not the cumulative agg_summary post count.

    sentiment uses invert=True so 'climbing' always means *healthier* (falling
    negative_ratio), keeping direction semantics uniform across pillars.
    """
    er_raw = [incremental_er(daily[: i + 1], window=7) for i in range(len(daily))]
    er_series = [v for v in er_raw if v is not None]
    neg_series = _series(daily, "negative_ratio")
    sentiment = _pillar_from_values("sentiment", neg_series, invert=True)
    # A negative_ratio flat at ~0 is the HEALTHIEST state, not a missing signal.
    # relative_slope returns None when the mean is 0 → "unknown"; remap that case
    # to a healthy plateau so clean groups aren't shown as a data gap nor flagged
    # as their own weakest pillar.
    if sentiment["direction"] == "unknown" and (not neg_series or max(neg_series) < 1e-9):
        sentiment["direction"] = "plateau"

    community = _pillar_from_values("community", community_series)
    # Community guards (2026-06-08 audit): a near-silent gallery (bdawn) or one
    # whose collection just started (a burst from a near-zero base, e.g. uryael)
    # can't yield a trustworthy trend — mark unknown so it isn't read as activity
    # nor flagged as a weak/strong pillar.
    active_days = sum(1 for v in community_series if v > 0)
    if (not community_series
            or community_series[-1] < MIN_COMMUNITY_VOLUME
            or active_days < MIN_COMMUNITY_ACTIVE_DAYS):
        community["direction"] = "unknown"
        community["accel_dir"] = "flat"

    # Reach: subscribers are the headline (audience size), but YouTube ROUNDS
    # large-channel subscriber counts, so the series freezes/quantizes and its
    # trajectory is noise. When the 4-week subscriber move is below the floor
    # (quantized or genuinely flat), fall back to the EXACT cumulative-view
    # velocity as a reach proxy — consumption growth still carries signal.
    subs = _series(daily, "yt_subscribers")
    subs_change = _change_4w(subs, relative=True)
    if subs_change is None or abs(subs_change) < REACH_NOISE_FLOOR:
        reach = _pillar_from_levels("reach", _series(daily, "yt_total_views"))
        reach["source"] = "views"
    else:
        reach = _pillar_from_levels("reach", subs, noise_floor=REACH_NOISE_FLOOR)
        reach["source"] = "subscribers"

    return [reach, _pillar_from_values("engagement", er_series), community, sentiment]


PILLAR_WEIGHTS = {"reach": 0.4, "engagement": 0.3, "community": 0.2, "sentiment": 0.1}

_DIR_SCORE = {"climbing": 1, "plateau": 0, "declining": -1, "unknown": 0}
_ACCEL_SCORE = {"accelerating": 1, "flat": 0, "decelerating": -1}


def _pillar_score(p: dict) -> int:
    return _DIR_SCORE[p["direction"]] + _ACCEL_SCORE[p["accel_dir"]]


def synthesize_posture(pillars: list[dict]) -> tuple[str, str | None]:
    """Growth-rate posture label + the single most-concerning pillar (or None).

    Every pillar is cumulative (flow-based), so a negative flow-slope means growth
    is SLOWING, not that the metric is falling. Labels are therefore framed as
    growth-rate ("성장 둔화") and never as absolute decline ("하락"/"악화") — a
    market leader whose weekly adds naturally moderate is still growing.

    weakest is the most-concerning pillar, but only surfaced when one is genuinely
    weak (combined score < 0). 'unknown' (no-signal) pillars are never candidates.
    When everything is holding or growing, weakest is None (no weak point).
    """
    dir_sum = sum(PILLAR_WEIGHTS[p["key"]] * _DIR_SCORE[p["direction"]] for p in pillars)
    acc_sum = sum(PILLAR_WEIGHTS[p["key"]] * _ACCEL_SCORE[p["accel_dir"]] for p in pillars)

    if dir_sum > 0.15:
        if acc_sum > 0.15:
            label = "성장 가속"
        elif acc_sum < -0.15:
            label = "성장 확대(둔화 조짐)"
        else:
            label = "성장 확대"
    elif dir_sum < -0.15:
        label = "성장 둔화 심화" if acc_sum < -0.15 else "성장 둔화"
    else:
        label = "성장 유지"

    judged = [p for p in pillars if p["direction"] != "unknown"]
    weakest = None
    if judged:
        worst = min(judged, key=_pillar_score)
        if _pillar_score(worst) < 0:
            weakest = worst["key"]
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

_FETCH_COMMUNITY_SQL = """
SELECT group_key, substr(posted_at, 1, 10) AS pday, COUNT(*) AS n
FROM community_posts
WHERE posted_at IS NOT NULL AND posted_at != ''
GROUP BY group_key, pday
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
    post_rows = client.execute(_FETCH_COMMUNITY_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    by_group: dict[str, list[dict]] = {}
    for r in rows:
        by_group.setdefault(r["group_key"], []).append(r)

    # Per-group {posted_at_day → count} for the recent-posting-volume pillar.
    posts_by_group: dict[str, dict[str, int]] = {}
    for r in post_rows:
        posts_by_group.setdefault(r["group_key"], {})[r["pday"]] = r["n"]

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [])]
    for group_key, group_rows in by_group.items():
        daily = resample_daily(group_rows)
        history_days = len(daily)
        if history_days < MIN_HISTORY_DAYS:
            statements.append((_UPSERT_SQL, [
                group_key, now, "insufficient_history", history_days,
                None, None, "[]",
            ]))
            continue
        community_series = community_activity_series(
            posts_by_group.get(group_key, {}), [r["day"] for r in daily],
        )
        pillars = compute_pillars(daily, community_series)
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
