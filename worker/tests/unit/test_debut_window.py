"""Tests for debut window organicity analysis module."""

import pytest

from idol_sight.analysis.debut_window import WINDOW_BUCKETS, bucket_for


def test_window_buckets_are_5_non_overlapping_ranges():
    """5 buckets, contiguous from -60 to +60, no overlap."""
    assert len(WINDOW_BUCKETS) == 5
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == ["D-60", "D-30", "D-Day", "D+30", "D+60"]
    # Ranges contiguous
    flat = []
    for _, lo, hi in WINDOW_BUCKETS:
        flat.append((lo, hi))
    assert flat == [(-60, -31), (-30, -2), (-1, 1), (2, 30), (31, 60)]


@pytest.mark.parametrize("days,expected", [
    (-60, "D-60"),
    (-45, "D-60"),
    (-31, "D-60"),
    (-30, "D-30"),
    (-2, "D-30"),
    (-1, "D-Day"),
    (0, "D-Day"),
    (1, "D-Day"),
    (2, "D+30"),
    (30, "D+30"),
    (31, "D+60"),
    (60, "D+60"),
])
def test_bucket_for_returns_correct_bucket(days, expected):
    assert bucket_for(days) == expected


@pytest.mark.parametrize("days", [-61, -100, 61, 100])
def test_bucket_for_returns_none_outside_window(days):
    assert bucket_for(days) is None


from idol_sight.analysis.debut_window import compute_engagement_score


@pytest.mark.parametrize("er,is_short,expected", [
    # Long-form: 0pt at 0.5%, 100pt at 5.5%
    (0.000, False, 0),     # below floor
    (0.005, False, 0),     # exact floor
    (0.030, False, 50),    # midpoint
    (0.055, False, 100),   # exact ceiling
    (0.100, False, 100),   # above ceiling clamps
    # Shorts: 0pt at 0.3%, 100pt at 3.3%
    (0.000, True, 0),
    (0.003, True, 0),
    (0.018, True, 50),
    (0.033, True, 100),
    (0.100, True, 100),
])
def test_compute_engagement_score(er, is_short, expected):
    assert compute_engagement_score(er, is_short) == expected


from idol_sight.analysis.debut_window import compute_balance_score


@pytest.mark.parametrize("ratio,expected", [
    # Normal zone: 15-80 returns 100
    (15.0, 100),
    (40.0, 100),
    (80.0, 100),
    # Below 15: penalize comment-farm (slope -8 per unit)
    (14.0, 92),    # 100 - (15-14)*8 = 92
    (10.0, 60),    # 100 - (15-10)*8 = 60
    (5.0, 20),
    (0.0, 0),      # clamp floor
    # Above 80: penalize like-farm (slope -0.2 per unit)
    (81.0, 100),   # 100 - 1/5 = 99.8 → rounds to 100
    (100.0, 96),   # 100 - 20/5 = 96
    (200.0, 76),
    (500.0, 16),
    (1000.0, 0),   # clamp floor
])
def test_compute_balance_score(ratio, expected):
    assert compute_balance_score(ratio) == expected


from idol_sight.analysis.debut_window import compute_velocity_coherence


@pytest.mark.parametrize("velocity,er,expected", [
    # Low/None velocity = neutral (50)
    (None, 0.02, 50),
    (0.5, 0.02, 50),
    (1.4, 0.02, 50),
    # Viral velocity (≥1.5) + good engagement = real viral
    (1.5, 0.04, 100),
    (5.0, 0.05, 100),
    # Viral velocity + moderate engagement = weak suspicion
    (3.0, 0.020, 60),
    (3.0, 0.015, 60),
    # Viral velocity + dead engagement = paid burst
    (3.0, 0.010, 20),
    (10.0, 0.001, 20),
])
def test_compute_velocity_coherence(velocity, er, expected):
    assert compute_velocity_coherence(velocity, er) == expected
