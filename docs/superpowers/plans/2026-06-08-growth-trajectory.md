# Growth Trajectory Layer (V2.43 Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-group "성장" tab showing self-history growth trajectory (reach / engagement-quality / community / sentiment) with WoW + 4-week trend + acceleration, a posture label, and a weakest-pillar flag.

**Architecture:** A worker analysis module (`growth_trajectory.py`) reads each group's `agg_summary` daily history, resamples to one row per KST day, derives per-pillar trajectory metrics over raw stored series (Frame A — no cohort-ref recompute), and writes one row per group into a new `group_growth_trajectory` table. A graceful API endpoint serves it to a new `GroupGrowth` tab view.

**Tech Stack:** Python 3.12 (uv, pytest) for worker; D1 SQL migration; Cloudflare Pages Functions (TypeScript) for API; Preact + Vite (vitest, tsc) for frontend.

**Spec:** `docs/superpowers/specs/2026-06-08-growth-trajectory-design.md`

---

## File Structure

- Create: `migrations/0081_group_growth_trajectory.sql` — new summary table.
- Create: `worker/src/idol_sight/analysis/growth_trajectory.py` — pure trajectory math + `build_growth_trajectory`.
- Create: `worker/tests/unit/test_growth_trajectory.py` — unit tests.
- Modify: `worker/src/idol_sight/cli.py` — register `build_growth_trajectory` in `_run_aggregate`.
- Create: `frontend/functions/api/growth-trajectory.ts` — graceful read endpoint.
- Modify: `frontend/src/api.ts` — add `growthTrajectory` method.
- Modify: `frontend/src/router.ts` — add `"growth"` to tab union.
- Modify: `frontend/src/components/GroupTabs.tsx` — add `["growth","성장"]`.
- Modify: `frontend/src/App.tsx` — route `tab==="growth"`.
- Create: `frontend/src/components/GrowthTrajectoryPanel.tsx` — presentational panel.
- Create: `frontend/src/views/GroupGrowth.tsx` — tab view wrapper.
- Modify: `CLAUDE.md` — V2.43 changelog entry.

---

## Task 1: Migration — `group_growth_trajectory` table

**Files:**
- Create: `migrations/0081_group_growth_trajectory.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0081_group_growth_trajectory.sql
-- V2.43: per-group growth trajectory snapshot (one row per group, full
-- DELETE + rebuild each aggregate cron). pillars is a JSON array of
-- {key, level, wow_growth, slope_4w, accel, direction, accel_dir}.
CREATE TABLE IF NOT EXISTS group_growth_trajectory (
  group_key      TEXT PRIMARY KEY,
  computed_at    TEXT NOT NULL,
  status         TEXT NOT NULL,        -- 'ok' | 'insufficient_history'
  history_days   INTEGER NOT NULL,
  posture_label  TEXT,                 -- NULL when insufficient
  weakest_pillar TEXT,                 -- NULL when insufficient
  pillars        TEXT NOT NULL DEFAULT '[]'
);
```

- [ ] **Step 2: Apply locally and verify**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: applies `0081_group_growth_trajectory` with no error.

Run: `cd frontend && wrangler d1 execute idol-sight --local --command "SELECT name FROM sqlite_master WHERE name='group_growth_trajectory';"`
Expected: one row `group_growth_trajectory`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0081_group_growth_trajectory.sql
git commit -m "feat(growth): migration 0081 group_growth_trajectory table"
```

> Remote apply is operator-gated (`gh workflow run migrate.yml`). The API (Task 9) degrades gracefully until then.

---

## Task 2: `resample_daily` — one row per KST day

**Files:**
- Create: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
"""Tests for growth trajectory analysis module."""
from idol_sight.analysis.growth_trajectory import _kst_day, resample_daily


def test_kst_day_shifts_utc_into_kst():
    # 2026-06-07T15:30:00Z is 2026-06-08 00:30 KST → KST day 2026-06-08
    assert _kst_day("2026-06-07T15:30:00Z") == "2026-06-08"
    assert _kst_day("2026-06-07T13:00:00Z") == "2026-06-07"


def test_resample_daily_keeps_latest_snapshot_per_kst_day():
    rows = [
        {"snapshot_at": "2026-06-07T01:00:00Z", "yt_subscribers": 100},
        {"snapshot_at": "2026-06-07T13:00:00Z", "yt_subscribers": 110},  # later same KST day
        {"snapshot_at": "2026-06-08T02:00:00Z", "yt_subscribers": 130},
    ]
    out = resample_daily(rows)
    assert [r["day"] for r in out] == ["2026-06-07", "2026-06-08"]
    assert out[0]["yt_subscribers"] == 110   # latest snapshot of 06-07 KST
    assert out[1]["yt_subscribers"] == 130
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -q`
Expected: FAIL — `ModuleNotFoundError`/`ImportError` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): resample_daily + _kst_day"
```

---

## Task 3: `_ols_slope` + `relative_slope`

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from idol_sight.analysis.growth_trajectory import relative_slope


def test_relative_slope_positive_for_rising_series():
    # rising by +10/day, mean ~ 145 over 28 pts → slope_per_day=10 → *7/mean
    vals = [100 + 10 * i for i in range(28)]
    rs = relative_slope(vals, window_days=28)
    assert rs is not None and rs > 0.3   # strongly climbing


def test_relative_slope_zero_for_flat_series():
    assert relative_slope([50.0] * 28, window_days=28) == 0.0


def test_relative_slope_none_when_too_short_or_zero_mean():
    assert relative_slope([1.0], window_days=28) is None
    assert relative_slope([0.0, 0.0], window_days=28) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k relative_slope -q`
Expected: FAIL — `ImportError: cannot import name 'relative_slope'`.

- [ ] **Step 3: Write minimal implementation** (append to `growth_trajectory.py`)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k relative_slope -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): relative_slope + _ols_slope"
```

---

## Task 4: `weekly_flow` + `acceleration`

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from idol_sight.analysis.growth_trajectory import acceleration, weekly_flow


def test_weekly_flow_is_7day_first_difference():
    # contiguous daily levels rising +5/day → 7-day flow = 35 once d-7 exists
    levels = [float(100 + 5 * i) for i in range(14)]
    flows = weekly_flow(levels, lag=7)
    # first 7 entries have no d-7 counterpart → dropped; rest are 35
    assert flows == [35.0] * 7


def test_acceleration_positive_when_recent_flow_exceeds_prior():
    # prior 14 ≈ 10, recent 14 ≈ 20 → accel ≈ +10
    series = [10.0] * 14 + [20.0] * 14
    assert acceleration(series, half=14) == 10.0


def test_acceleration_zero_when_insufficient():
    assert acceleration([1.0, 2.0], half=14) == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k "weekly_flow or acceleration" -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k "weekly_flow or acceleration" -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): weekly_flow + acceleration"
```

---

## Task 5: classifiers — `classify_direction`, `classify_accel`

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
import pytest
from idol_sight.analysis.growth_trajectory import classify_accel, classify_direction


@pytest.mark.parametrize("rs,expected", [
    (0.20, "climbing"), (0.05001, "climbing"),
    (0.0, "plateau"), (0.05, "plateau"), (-0.05, "plateau"),
    (-0.20, "declining"), (None, "unknown"),
])
def test_classify_direction(rs, expected):
    assert classify_direction(rs) == expected


@pytest.mark.parametrize("a,expected", [
    (5.0, "accelerating"), (-5.0, "decelerating"), (0.0, "flat"),
])
def test_classify_accel(a, expected):
    assert classify_accel(a, deadband=1.0) == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k classify -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k classify -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): direction + accel classifiers"
```

---

## Task 6: `incremental_er`

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from idol_sight.analysis.growth_trajectory import incremental_er


def test_incremental_er_uses_deltas_over_window():
    # views +100000, likes+comments +5000 over window → ER = 0.05
    daily = [
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_000, "yt_comments_total": 5_000},
        {"yt_total_views": 1_100_000, "yt_likes_total": 44_000, "yt_comments_total": 6_000},
    ]
    er = incremental_er(daily, window=1)
    assert er is not None and abs(er - 0.05) < 1e-9


def test_incremental_er_none_when_no_new_views():
    daily = [
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_000, "yt_comments_total": 5_000},
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_010, "yt_comments_total": 5_000},
    ]
    assert incremental_er(daily, window=1) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k incremental_er -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k incremental_er -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): incremental_er"
```

---

## Task 7: `compute_pillars` (per-group pillar dicts)

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from idol_sight.analysis.growth_trajectory import compute_pillars


def _rising_daily(n=40):
    """n contiguous KST days, all metrics rising, negative_ratio flat 0."""
    rows = []
    for i in range(n):
        rows.append({
            "day": f"2026-04-{i + 1:02d}" if i < 30 else f"2026-05-{i - 29:02d}",
            "yt_subscribers": 5000 + 300 * i,
            "yt_total_views": 900_000 + 80_000 * i,
            "yt_likes_total": 8000 + 400 * i,
            "yt_comments_total": 500 + 30 * i,
            "dc_total_posts": 30 + 2 * i,
            "theqoo_posts": 0, "instiz_posts": 0, "twitter_posts": 0,
            "negative_ratio": 0.0,
        })
    return rows


def test_compute_pillars_returns_four_keyed_pillars_climbing():
    pillars = compute_pillars(_rising_daily())
    keys = {p["key"] for p in pillars}
    assert keys == {"reach", "engagement", "community", "sentiment"}
    reach = next(p for p in pillars if p["key"] == "reach")
    assert reach["direction"] == "climbing"
    # every pillar dict has the contract fields
    for p in pillars:
        assert set(p) >= {"key", "level", "wow_growth", "slope_4w", "accel",
                          "direction", "accel_dir"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k compute_pillars -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k compute_pillars -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): compute_pillars (reach/engagement/community/sentiment)"
```

---

## Task 8: `synthesize_posture` (label + weakest pillar)

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from idol_sight.analysis.growth_trajectory import synthesize_posture


def _pillar(key, direction, accel_dir, slope=0.1, accel=1.0):
    return {"key": key, "direction": direction, "accel_dir": accel_dir,
            "slope_4w": slope, "accel": accel}


def test_posture_rising_accelerating_and_weakest_is_declining():
    pillars = [
        _pillar("reach", "climbing", "accelerating", 0.3, 5.0),
        _pillar("engagement", "climbing", "flat", 0.1, 0.0),
        _pillar("community", "declining", "decelerating", -0.2, -3.0),
        _pillar("sentiment", "plateau", "flat", 0.0, 0.0),
    ]
    label, weakest = synthesize_posture(pillars)
    assert label == "상승·가속"
    assert weakest == "community"


def test_posture_declining_label():
    pillars = [
        _pillar("reach", "declining", "decelerating", -0.3, -5.0),
        _pillar("engagement", "declining", "decelerating", -0.2, -3.0),
        _pillar("community", "plateau", "flat", 0.0, 0.0),
        _pillar("sentiment", "plateau", "flat", 0.0, 0.0),
    ]
    label, _ = synthesize_posture(pillars)
    assert label.startswith("하락")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k posture -q`
Expected: FAIL — ImportError.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k posture -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): synthesize_posture + weakest pillar"
```

---

## Task 9: `build_growth_trajectory` (fetch → per-group rows → upserts)

**Files:**
- Modify: `worker/src/idol_sight/analysis/growth_trajectory.py`
- Test: `worker/tests/unit/test_growth_trajectory.py`

- [ ] **Step 1: Write the failing test**

```python
from unittest.mock import MagicMock
from idol_sight.analysis.growth_trajectory import (
    MIN_HISTORY_DAYS,
    build_growth_trajectory,
)


def _fetch_rows_for(group, n):
    rows = []
    for i in range(n):
        rows.append({
            "group_key": group,
            "snapshot_at": f"2026-04-{i + 1:02d}T13:00:00Z",
            "yt_subscribers": 5000 + 300 * i,
            "yt_total_views": 900_000 + 80_000 * i,
            "yt_likes_total": 8000 + 400 * i,
            "yt_comments_total": 500 + 30 * i,
            "dc_total_posts": 30 + 2 * i, "theqoo_posts": 0,
            "instiz_posts": 0, "twitter_posts": 0, "negative_ratio": 0.0,
        })
    return rows


def _client(rows):
    client = MagicMock()
    client.execute.side_effect = lambda sql, params=None: rows
    return client


def test_build_emits_delete_then_per_group_upserts():
    rows = _fetch_rows_for("miiwan", 30) + _fetch_rows_for("bthd", 5)
    result = build_growth_trajectory(_client(rows))
    sqls = [s[0] for s in result.statements]
    assert "DELETE FROM group_growth_trajectory" in sqls[0]
    # one upsert per group
    upserts = [s for s in result.statements if "INSERT INTO group_growth_trajectory" in s[0]]
    assert len(upserts) == 2
    by_group = {s[1][0]: s[1] for s in upserts}
    assert set(by_group) == {"miiwan", "bthd"}


def test_build_marks_thin_history_insufficient():
    rows = _fetch_rows_for("bthd", MIN_HISTORY_DAYS - 1)
    result = build_growth_trajectory(_client(rows))
    upsert = next(s for s in result.statements if "INSERT INTO" in s[0])
    params = upsert[1]
    # params: group_key, computed_at, status, history_days, posture, weakest, pillars
    assert params[0] == "bthd"
    assert params[2] == "insufficient_history"
    assert params[4] is None and params[5] is None


def test_build_marks_ok_and_climbing_for_rich_history():
    rows = _fetch_rows_for("miiwan", 40)
    result = build_growth_trajectory(_client(rows))
    upsert = next(s for s in result.statements if "INSERT INTO" in s[0])
    params = upsert[1]
    assert params[2] == "ok"
    assert params[4] is not None        # posture_label
    pillars = json.loads(params[6])
    assert len(pillars) == 4
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -k build -q`
Expected: FAIL — ImportError on `MIN_HISTORY_DAYS`/`build_growth_trajectory`.

- [ ] **Step 3: Write minimal implementation** (append)

```python
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
```

- [ ] **Step 4: Run test to verify it passes + full module suite**

Run: `cd worker && uv run pytest tests/unit/test_growth_trajectory.py -q`
Expected: PASS (all growth tests).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/growth_trajectory.py worker/tests/unit/test_growth_trajectory.py
git commit -m "feat(growth): build_growth_trajectory (fetch→pillars→upserts)"
```

---

## Task 10: Register in `cli.py` aggregate

**Files:**
- Modify: `worker/src/idol_sight/cli.py` (inside `_run_aggregate`, right after the debut_window block ending at the `debut_window_summary: wrote …` echo, ~line 408)

- [ ] **Step 1: Add the build call**

Locate (in `_run_aggregate`):

```python
        typer.echo(f"debut_window_summary: wrote {len(dw_summary.statements)} rows")
    else:
```

Insert before the `    else:` line:

```python
        # V2.43: per-group growth trajectory (raw-pillar, self-history). Like
        # debut_window it doesn't read melon, so it lives in skip_derived branch.
        from idol_sight.analysis.growth_trajectory import build_growth_trajectory
        gt = build_growth_trajectory(client)
        if gt.statements:
            bs = client.batch(gt.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial growth_trajectory write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"growth_trajectory: wrote {len(gt.statements)} rows")
```

- [ ] **Step 2: Run the full worker suite**

Run: `cd worker && uv run pytest -q`
Expected: PASS (all existing + new growth tests; no import/collection errors).

- [ ] **Step 3: Commit**

```bash
git add worker/src/idol_sight/cli.py
git commit -m "feat(growth): register build_growth_trajectory in aggregate"
```

---

## Task 11: API endpoint `growth-trajectory.ts` (graceful)

**Files:**
- Create: `frontend/functions/api/growth-trajectory.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// frontend/functions/api/growth-trajectory.ts
//
// Returns the latest growth-trajectory snapshot for one group. Graceful:
// if the table doesn't exist yet (migration 0081 not applied), or the group
// has no row, returns { status: "no_data" } instead of 500 — so a deploy that
// precedes the operator's remote migration apply doesn't break the tab.

import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface TrajectoryRow {
  group_key: string;
  computed_at: string;
  status: string;
  history_days: number;
  posture_label: string | null;
  weakest_pillar: string | null;
  pillars: string;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  if (!group) return jsonResponse({ error: "group required" }, 400);

  try {
    const rows = await d1Query<TrajectoryRow>(
      env.DB,
      `SELECT group_key, computed_at, status, history_days,
              posture_label, weakest_pillar, pillars
       FROM group_growth_trajectory WHERE group_key = ?`,
      [group],
    );
    const row = rows[0];
    if (!row) return jsonResponse({ status: "no_data" }, 200);
    let pillars: unknown = [];
    try { pillars = JSON.parse(row.pillars); } catch { pillars = []; }
    return jsonResponse({
      status: row.status,
      computed_at: row.computed_at,
      history_days: row.history_days,
      posture_label: row.posture_label,
      weakest_pillar: row.weakest_pillar,
      pillars,
    }, 200);
  } catch {
    // table missing (pre-migration) or query error → graceful empty.
    return jsonResponse({ status: "no_data" }, 200);
  }
};
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && node_modules/.bin/tsc -b --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/functions/api/growth-trajectory.ts
git commit -m "feat(growth): /api/growth-trajectory endpoint (graceful)"
```

---

## Task 12: Frontend wiring — api.ts, router, GroupTabs, App

**Files:**
- Modify: `frontend/src/api.ts` (inside the `api` object, after `debutWindowSummary` ~line 50)
- Modify: `frontend/src/router.ts:2` (tab union)
- Modify: `frontend/src/components/GroupTabs.tsx:19-24` (GROUP_TABS)
- Modify: `frontend/src/App.tsx` (after the `risk` route line ~49)

- [ ] **Step 1: api.ts — add method**

Add inside the `api` object (after the `debutWindowSummary` entry):

```typescript
  growthTrajectory: <T = unknown>(group: string): Promise<T> =>
    getJson<T>(`/api/growth-trajectory?group=${encodeURIComponent(group)}`),
```

- [ ] **Step 2: router.ts — extend tab union**

Change line 2 from:

```typescript
  tab: "market" | "weekly" | "content" | "members" | "community" | "risk" | "insights" | "miiwan" | "shorts" | "status";
```

to (add `"growth"`):

```typescript
  tab: "market" | "weekly" | "content" | "members" | "community" | "risk" | "growth" | "insights" | "miiwan" | "shorts" | "status";
```

- [ ] **Step 3: GroupTabs.tsx — add tab entry**

Change the `GROUP_TABS` array (lines 19-24) to append the growth tab:

```typescript
const GROUP_TABS: Array<[RouterState["tab"], string]> = [
  ["content",   "그룹 상세"],
  ["members",   "멤버"],
  ["community", "커뮤니티"],
  ["risk",      "PR/리스크"],
  ["growth",    "성장"],
];
```

- [ ] **Step 4: App.tsx — route the tab**

After the line `{state.tab === "risk"      && <PRRisk groupKey={state.group} />}`, add:

```tsx
        {state.tab === "growth"    && <GroupGrowth groupKey={state.group} />}
```

And add the import near the other view imports (e.g., after the GroupContent import):

```tsx
import { GroupGrowth } from "./views/GroupGrowth";
```

- [ ] **Step 5: Typecheck (expected to fail until Task 13 creates GroupGrowth)**

Run: `cd frontend && node_modules/.bin/tsc -b --noEmit`
Expected: FAIL — `Cannot find module './views/GroupGrowth'`. (Resolved in Task 13.) Do NOT commit yet.

---

## Task 13: `GrowthTrajectoryPanel` + `GroupGrowth` view

**Files:**
- Create: `frontend/src/components/GrowthTrajectoryPanel.tsx`
- Create: `frontend/src/views/GroupGrowth.tsx`

- [ ] **Step 1: Create the panel component**

```tsx
// frontend/src/components/GrowthTrajectoryPanel.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface Pillar {
  key: string;
  level: number | null;
  wow_growth: number | null;
  slope_4w: number | null;
  accel: number;
  direction: string;   // climbing | plateau | declining | unknown
  accel_dir: string;   // accelerating | flat | decelerating
}
interface Trajectory {
  status: string;       // ok | insufficient_history | no_data
  computed_at?: string;
  history_days?: number;
  posture_label?: string | null;
  weakest_pillar?: string | null;
  pillars?: Pillar[];
}

const PILLAR_LABEL: Record<string, string> = {
  reach: "도달 성장", engagement: "호응 품질",
  community: "커뮤니티 모멘텀", sentiment: "여론",
};
const DIR_ARROW: Record<string, string> = {
  climbing: "↗", plateau: "→", declining: "↘", unknown: "·",
};
const DIR_COLOR: Record<string, string> = {
  climbing: "#22c55e", plateau: "#a1a1aa", declining: "#ef4444", unknown: "#71717a",
};
const ACCEL_LABEL: Record<string, string> = {
  accelerating: "가속", flat: "—", decelerating: "감속",
};

function fmtWoW(p: Pillar): string {
  if (p.wow_growth === null) return "—";
  if (p.key === "engagement") return `ER ${(p.wow_growth * 100).toFixed(2)}p`;
  if (p.key === "sentiment") return `${(p.wow_growth * 100).toFixed(1)}%p`;
  return `${p.wow_growth >= 0 ? "+" : ""}${(p.wow_growth * 100).toFixed(0)}%/주`;
}

export function GrowthTrajectoryPanel({ groupKey }: { groupKey: string }) {
  const [data, setData] = useState<Trajectory | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.growthTrajectory<Trajectory>(groupKey)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData({ status: "no_data" }); });
    return () => { cancelled = true; };
  }, [groupKey]);

  if (!data) return <div class="text-zinc-500 text-sm">Loading…</div>;

  if (data.status === "no_data") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        아직 성장 궤적 데이터가 없습니다. (다음 집계 cron 이후 표시)
      </div>
    );
  }
  if (data.status === "insufficient_history") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        데이터 축적 중 ({data.history_days ?? 0}일 / 최소 14일). 궤적은 14일 이상부터 표시됩니다.
      </div>
    );
  }

  const pillars = data.pillars ?? [];
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-3 flex items-baseline justify-between">
        <h3 class="section-title">성장 궤적</h3>
        <span class="text-lg font-semibold text-zinc-100">{data.posture_label ?? "—"}</span>
      </div>
      <div class="space-y-2">
        {pillars.map((p) => (
          <div key={p.key} class="flex items-center gap-3 text-sm">
            <span class="w-28 shrink-0 text-zinc-300">{PILLAR_LABEL[p.key] ?? p.key}</span>
            <span class="w-24 shrink-0 tabular-nums text-zinc-400">{fmtWoW(p)}</span>
            <span class="w-6 shrink-0 text-center" style={{ color: DIR_COLOR[p.direction] }}>
              {DIR_ARROW[p.direction] ?? "·"}
            </span>
            <span class="text-zinc-500">{ACCEL_LABEL[p.accel_dir] ?? "—"}</span>
            {data.weakest_pillar === p.key && (
              <span class="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-200">
                ⚠ 가장 약한 궤적
              </span>
            )}
          </div>
        ))}
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-zinc-500">
        자기 과거 대비(WoW + 4주 추세 + 가속) · 등급 아닌 방향 사실 · 휴리스틱 추정(ground-truth 아님, 인간 검증 필요).
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Create the view wrapper**

```tsx
// frontend/src/views/GroupGrowth.tsx
import { GroupTabs } from "../components/GroupTabs";
import { GrowthTrajectoryPanel } from "../components/GrowthTrajectoryPanel";
import { EmptyState } from "../components/EmptyState";

export function GroupGrowth({ groupKey }: { groupKey: string | null }) {
  return (
    <div>
      <GroupTabs />
      {groupKey
        ? <GrowthTrajectoryPanel groupKey={groupKey} />
        : <EmptyState title="그룹을 선택하세요" hint="시장 개요에서 그룹을 고르면 성장 궤적이 표시됩니다." icon="📈" />}
    </div>
  );
}
```

- [ ] **Step 3: Verify EmptyState import path**

Run: `cd frontend && ls src/components/EmptyState.tsx`
Expected: file exists. If the export name differs, run `grep -n "export" src/components/EmptyState.tsx` and match the import in Step 2. (GroupContent already imports EmptyState — mirror its import.)

- [ ] **Step 4: Typecheck + tests**

Run: `cd frontend && node_modules/.bin/tsc -b --noEmit && node_modules/.bin/vitest run`
Expected: tsc exit 0; all existing tests pass (174).

- [ ] **Step 5: Commit (Task 12 + 13 together — they compile as a unit)**

```bash
git add frontend/src/api.ts frontend/src/router.ts frontend/src/components/GroupTabs.tsx frontend/src/App.tsx frontend/src/components/GrowthTrajectoryPanel.tsx frontend/src/views/GroupGrowth.tsx
git commit -m "feat(growth): 성장 tab — GroupGrowth view + GrowthTrajectoryPanel + wiring"
```

---

## Task 14: CLAUDE.md changelog + final verification

**Files:**
- Modify: `CLAUDE.md` (add V2.43 entry before the "다음 단계 (우선순위)" line)

- [ ] **Step 1: Add the changelog entry**

Insert before `**다음 단계 (우선순위)**:`:

```markdown
- **V2.43 (2026-06-08)**: 성장 궤적 레이어 Phase 1 (모든 그룹 `성장` 탭). 대시보드가 상태 진단(organicity/건전성/멤버비중)엔 강하나 "건강히 성장하는가/어디가 부족한가"가 약했음 — 바이탈 패널이 "안정"과 "정체"를 구분 못 함. Frame A(자기 과거 대비) 원천 기둥 궤적: 도달 성장(Δsubs/주)·호응 품질(증분 ER=Δ(likes+comments)/Δviews)·커뮤니티 모멘텀·여론(negative_ratio invert). WoW + 4주 상대기울기 + 가속 → climbing/plateau/declining × accel/decel, posture 라벨 + 약점 플래그(등급 아닌 방향 사실, 휴리스틱). worker `analysis/growth_trajectory.py`(KST 일별 리샘플 → 주간 flow → 궤적, 순수함수 분해 + `build_growth_trajectory` full DELETE+rebuild) → migration 0081 `group_growth_trajectory`(그룹당 1행, JSON pillars) → `/api/growth-trajectory`(graceful no_data) → `GroupGrowth` 탭 뷰. <14일 history(BTHD)는 insufficient_history "데이터 축적 중". 처방·깔때기 전환·기대대비갭(Frame B/C)·카드 축약 배지는 Phase 2+. 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-08-growth-trajectory*`. migration 0081 운영자 원격 apply 필요.
```

- [ ] **Step 2: Full verification (worker + frontend)**

Run: `cd worker && uv run pytest -q`
Expected: all pass.

Run: `cd frontend && node_modules/.bin/tsc -b --noEmit && node_modules/.bin/vitest run`
Expected: tsc exit 0; 174 pass.

- [ ] **Step 3: Commit + push**

```bash
git add CLAUDE.md
git commit -m "docs(growth): V2.43 changelog"
git push origin main
```

- [ ] **Step 4: Operator follow-up note**

After push, remind the operator: remote migration apply is human-gated. Run:
`! gh workflow run migrate.yml` (or `wrangler d1 migrations apply idol-sight --remote`)
Then the next aggregate cron (21:30 KST) populates `group_growth_trajectory` and the 성장 tab fills in.

---

## Self-Review Notes

- **Spec coverage:** pillars (Task 7), WoW+slope+accel (Tasks 3-5,7), posture+weakest (Task 8), table (Task 1), worker build (Task 9), cli register (Task 10), API graceful (Task 11), tab+view+wiring (Tasks 12-13), insufficient_history (Task 9/13), CLAUDE.md (Task 14). All spec sections mapped.
- **Sentiment inversion:** handled in `compute_pillars` via `invert=True` so "climbing"=healthier — consistent across Tasks 7/8/13.
- **Type consistency:** pillar dict keys `{key, level, wow_growth, slope_4w, accel, direction, accel_dir}` identical in Task 7 (Python), Task 9 (JSON), Task 13 (TS `Pillar`). Upsert param order in Task 9 matches the `insufficient_history` test asserts (status idx 2, posture idx 4, weakest idx 5, pillars idx 6).
- **Migration gating:** API graceful (Task 11) + operator note (Task 14) cover the deploy-before-migrate window per CLAUDE.md rule.
