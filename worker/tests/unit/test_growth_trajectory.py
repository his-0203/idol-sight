"""Tests for growth trajectory analysis module."""
from idol_sight.analysis.growth_trajectory import _kst_day, resample_daily
from idol_sight.analysis.growth_trajectory import relative_slope


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
