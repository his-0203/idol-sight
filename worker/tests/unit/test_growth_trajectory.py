"""Tests for growth trajectory analysis module."""
from idol_sight.analysis.growth_trajectory import _kst_day, resample_daily
from idol_sight.analysis.growth_trajectory import relative_slope
from idol_sight.analysis.growth_trajectory import acceleration, weekly_flow
import pytest
from idol_sight.analysis.growth_trajectory import classify_accel, classify_direction
from idol_sight.analysis.growth_trajectory import incremental_er


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


def test_relative_slope_positive_for_rising_series():
    # rising by +10/day over 28 pts → slope_per_day=10, mean=235 → *7/235 ≈ 0.298
    # plan comment said "mean ~ 145" (arithmetic error in plan); correct mean is 235.
    # boundary adjusted from >0.3 to >0.25 — still unambiguously "strongly climbing".
    vals = [100 + 10 * i for i in range(28)]
    rs = relative_slope(vals, window_days=28)
    assert rs is not None and rs > 0.25   # strongly climbing


def test_relative_slope_zero_for_flat_series():
    assert relative_slope([50.0] * 28, window_days=28) == 0.0


def test_relative_slope_none_when_too_short_or_zero_mean():
    assert relative_slope([1.0], window_days=28) is None
    assert relative_slope([0.0, 0.0], window_days=28) is None


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
