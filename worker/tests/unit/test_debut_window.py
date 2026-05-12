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
