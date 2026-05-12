"""Tests for debut window organicity analysis module."""

import pytest

from idol_sight.analysis.debut_window import (
    WINDOW_BUCKETS,
    bucket_for,
    _compute_engagement_score,
    _compute_balance_score,
    _compute_velocity_coherence,
    _classify_verdict,
    compute_organic_score,
)


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
    assert _compute_engagement_score(er, is_short) == expected


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
    assert _compute_balance_score(ratio) == expected


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
    assert _compute_velocity_coherence(velocity, er) == expected


def test_classify_verdict_thresholds():
    assert _classify_verdict(70) == "organic"
    assert _classify_verdict(85) == "organic"
    assert _classify_verdict(69) == "suspect"
    assert _classify_verdict(40) == "suspect"
    assert _classify_verdict(39) == "likely_paid"
    assert _classify_verdict(0) == "likely_paid"


def test_compute_organic_score_insufficient_data_low_views():
    """View count < 1000 AND engagement < 10 → insufficient_data, score None."""
    video = {
        "is_short": False,
        "view_count": 500,
        "like_count": 3,
        "comment_count": 2,
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score is None
    assert breakdown["verdict"] == "insufficient_data"


def test_compute_organic_score_long_form_clearly_organic():
    """High engagement, balanced ratio, no velocity signal → score ≥ 70."""
    video = {
        "is_short": False,
        "view_count": 1_000_000,
        "like_count": 60_000,    # 6% engagement (likes+comments)/views
        "comment_count": 2_000,  # like:comment = 30 (normal zone)
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # engagement_rate = 62000/1000000 = 0.062 → engagement_score=100
    # balance_score (30) = 100
    # velocity_coherence (None) = 50
    # composite = 0.5*100 + 0.3*100 + 0.2*50 = 90
    assert score == 90
    assert breakdown["verdict"] == "organic"
    assert dict(breakdown["weights"]) == {
        "engagement": 0.5, "balance": 0.3, "velocity": 0.2,
    }


def test_compute_organic_score_paid_burst_pattern():
    """High views, dead engagement, velocity spike → score < 40."""
    video = {
        "is_short": False,
        "view_count": 3_000_000,
        "like_count": 18_000,    # 0.6% engagement → engagement_score=0 (≤0.5%)
        "comment_count": 200,    # like:comment = 90 → balance_score≈98
        "viral_velocity_ratio": 5.0,  # velocity spike, low ER → coherence=20
    }
    score, breakdown = compute_organic_score(video)
    # er = 18200/3_000_000 = 0.00607 → engagement_score = round((0.00607-0.005)/0.05*100) = 2
    # balance: ratio=90 → 100 - (90-80)/5 = 98
    # velocity: ratio=5.0, er<0.015 → 20
    # composite = 0.5*2 + 0.3*98 + 0.2*20 = 1 + 29.4 + 4 = 34.4 → 34
    assert score == 34
    assert breakdown["verdict"] == "likely_paid"


def test_compute_organic_score_handles_zero_view_safely():
    """Zero views shouldn't crash; falls to insufficient_data."""
    video = {
        "is_short": False,
        "view_count": 0,
        "like_count": 0,
        "comment_count": 0,
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score is None
    assert breakdown["verdict"] == "insufficient_data"


@pytest.mark.parametrize("view_count,engagement_total,expect_insufficient", [
    # Both gates failing → insufficient
    (999, 9, True),
    # View gate met (>=1000) → sufficient (engagement_total alone irrelevant)
    (1000, 9, False),
    (1000, 0, False),
    # Engagement gate met (>=10) → sufficient (low views alone irrelevant)
    (999, 10, False),
    (0, 10, False),
    # Clearly above both → sufficient
    (10_000, 100, False),
])
def test_insufficient_data_boundary(view_count, engagement_total, expect_insufficient):
    # Distribute engagement_total between likes/comments arbitrarily (3:1)
    like_count = (engagement_total * 3) // 4
    comment_count = engagement_total - like_count
    video = {
        "is_short": False,
        "view_count": view_count,
        "like_count": like_count,
        "comment_count": comment_count,
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    if expect_insufficient:
        assert score is None
        assert breakdown["verdict"] == "insufficient_data"
    else:
        # May be any of organic/suspect/likely_paid depending on signal mix;
        # the contract here is just that we *do* score it.
        assert score is not None
        assert breakdown["verdict"] != "insufficient_data"
