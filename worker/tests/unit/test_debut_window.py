"""Tests for debut window organicity analysis module."""

import json
from unittest.mock import MagicMock

import pytest

from idol_sight.analysis.debut_window import (
    WINDOW_BUCKETS,
    _classify_verdict,
    _compute_balance_score,
    _compute_engagement_score,
    _compute_velocity_coherence,
    bucket_for,
    build_summary,
    build_video_organicity,
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
    # V2 long-form: 0pt at 1.0%, 100pt at 6.0%
    (0.000, False, 0),     # below floor
    (0.010, False, 0),     # exact floor
    (0.035, False, 50),    # midpoint (1.0+6.0)/2 = 3.5%
    (0.060, False, 100),   # exact ceiling
    (0.100, False, 100),   # above ceiling clamps
    # V2 shorts: 0pt at 1.5%, 100pt at 8.0%
    (0.000, True, 0),
    (0.015, True, 0),
    (0.0475, True, 50),    # midpoint (1.5+8.0)/2 = 4.75%
    (0.080, True, 100),
    (0.150, True, 100),
])
def test_compute_engagement_score(er, is_short, expected):
    assert _compute_engagement_score(er, is_short) == expected


@pytest.mark.parametrize("ratio,is_short,expected", [
    # V2 long-form normal zone: 10-50 returns 100
    (10.0, False, 100),
    (30.0, False, 100),
    (50.0, False, 100),
    # Long below 10: -8/unit (comment-farm)
    (9.0,  False, 92),    # 100 - (10-9)*8 = 92
    (5.0,  False, 60),    # 100 - (10-5)*8 = 60
    (0.0,  False, 20),    # 100 - 10*8 = 20
    # Long above 50: -0.5/unit (like-farm)
    (60.0, False, 95),    # 100 - 10*0.5 = 95
    (100.0, False, 75),   # 100 - 50*0.5 = 75
    (300.0, False, 0),    # 100 - 250*0.5 clamps to 0
    # V2 shorts normal zone: 20-150 returns 100
    (20.0,  True, 100),
    (80.0,  True, 100),
    (150.0, True, 100),
    # Shorts below 20: -4/unit
    (15.0, True, 80),     # 100 - (20-15)*4 = 80
    (10.0, True, 60),
    (0.0,  True, 20),     # 100 - 20*4 = 20
    # Shorts above 150: -0.1/unit
    (200.0, True, 95),    # 100 - 50*0.1 = 95
    (500.0, True, 65),
    (1500.0, True, 0),    # clamps to 0
])
def test_compute_balance_score(ratio, is_short, expected):
    assert _compute_balance_score(ratio, is_short) == expected


@pytest.mark.parametrize("velocity,er,expected", [
    # V2: None velocity = signal absent (None, not 50)
    (None, 0.02, None),
    # Low velocity (<1.5) = neutral 50 (signal alive)
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
    """High engagement, balanced ratio, no velocity signal → score ≥ 70.
    V2: NULL velocity redistributes weights → engagement 0.625 + balance 0.375."""
    video = {
        "is_short": False,
        "view_count": 1_000_000,
        "like_count": 60_000,    # ~6% engagement (likes+comments)/views
        "comment_count": 2_000,  # like:comment = 30 (long normal zone 10-50)
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # engagement_rate = 62000/1000000 = 0.062 → at long ceil 6.0% → engagement_score=100
    # balance (ratio=30, long) = 100
    # velocity = None → weights redistribute
    # composite = 0.625*100 + 0.375*100 = 100
    assert score == 100
    assert breakdown["verdict"] == "organic"
    assert dict(breakdown["weights"]) == {"engagement": 0.625, "balance": 0.375}
    assert breakdown["velocity_coherence_score"] is None


def test_compute_organic_score_paid_burst_pattern():
    """High views, dead engagement, velocity spike → score < 40 (V2 calibrated)."""
    video = {
        "is_short": False,
        "view_count": 3_000_000,
        "like_count": 18_000,    # 0.6% engagement
        "comment_count": 200,    # like:comment = 90
        "viral_velocity_ratio": 5.0,  # velocity spike, low ER
    }
    score, breakdown = compute_organic_score(video)
    # er = 18200/3_000_000 = 0.00607 → V2 long floor 1.0% → engagement_score = 0
    # balance: ratio=90, long → above 50 normal zone → 100 - (90-50)*0.5 = 80
    # velocity: ratio=5.0, er<1.5% → 20
    # composite = 0.5*0 + 0.3*80 + 0.2*20 = 0 + 24 + 4 = 28
    assert score == 28
    assert breakdown["verdict"] == "likely_paid"
    assert dict(breakdown["weights"]) == {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}


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


def _client(rows_by_sql_substring):
    """Test helper: MagicMock client whose .execute(sql) returns rows
    based on first matching substring in rows_by_sql_substring."""
    client = MagicMock()
    def _execute(sql, params=None):
        for sub, rows in rows_by_sql_substring.items():
            if sub in sql:
                return rows
        return []
    client.execute.side_effect = _execute
    return client


def test_build_video_organicity_filters_window_and_emits_upserts():
    """Reads videos in ±60 day window, scores each, returns upsert statements."""
    # Two miiwan videos: one inside D-30 window, one outside (D-166)
    client = _client({
        "FROM youtube_videos": [
            {
                "video_id": "vid_inside",
                "group_key": "miiwan",
                "is_short": 0,
                "published_at": "2026-06-01T00:00:00Z",  # D-15 → D-30 bucket
                "view_count": 500_000,
                "like_count": 30_000,
                "comment_count": 1_000,
                "viral_velocity_ratio": None,
                "debut_date": "2026-06-16",
            },
            {
                "video_id": "vid_outside",
                "group_key": "miiwan",
                "is_short": 0,
                "published_at": "2026-01-01T00:00:00Z",  # ~D-166
                "view_count": 100_000,
                "like_count": 5_000,
                "comment_count": 100,
                "viral_velocity_ratio": None,
                "debut_date": "2026-06-16",
            },
        ],
    })
    result = build_video_organicity(client)

    # Only the in-window video gets an upsert; out-of-window is skipped
    sqls = [s[0] for s in result.statements]
    params_list = [s[1] for s in result.statements]
    assert len(result.statements) == 1
    assert "INSERT INTO debut_window_video_organicity" in sqls[0]
    assert "ON CONFLICT(video_id) DO UPDATE" in sqls[0]
    # video_id in first param position
    assert params_list[0][0] == "vid_inside"
    # window_bucket present (published 2026-06-01 vs debut 2026-06-16 = D-15 → D-30 bucket)
    assert "D-30" in params_list[0]
    # signal_breakdown is JSON
    breakdown_json = next(p for p in params_list[0] if isinstance(p, str) and p.startswith("{"))
    parsed = json.loads(breakdown_json)
    assert "engagement_score" in parsed


def test_fetch_sql_uses_real_youtube_video_stats_columns():
    """The fetch SQL must alias the real youtube_video_stats column names
    (views/likes/comments) to view_count/like_count/comment_count so the
    rest of the code receives the keys it expects.

    Regression guard: if someone changes _FETCH_VIDEOS_SQL to read
    `s.view_count`/etc directly (the wrong column names — they don't
    exist in youtube_video_stats), production will silently return all
    NULL stats and classify every video as insufficient_data.
    """
    from idol_sight.analysis.debut_window import _FETCH_VIDEOS_SQL
    # Real column names from migrations/0001_init.sql must appear
    assert "s.views" in _FETCH_VIDEOS_SQL
    assert "s.likes" in _FETCH_VIDEOS_SQL
    assert "s.comments" in _FETCH_VIDEOS_SQL
    # And must be aliased (otherwise downstream code with .get("view_count")
    # gets None even when stats exist)
    assert "AS view_count" in _FETCH_VIDEOS_SQL
    assert "AS like_count" in _FETCH_VIDEOS_SQL
    assert "AS comment_count" in _FETCH_VIDEOS_SQL


def test_build_summary_groups_by_bucket_with_view_weighted_mean():
    """Aggregates per (group_key, window_bucket). Excludes insufficient_data
    from ratio denominator. Score mean is view-weighted."""
    client = _client({
        "FROM debut_window_video_organicity": [
            # plave D-30: 3 videos, 2 organic + 1 likely_paid
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 1_000_000, "organic_score": 80, "verdict": "organic",
             "like_count": 50_000, "comment_count": 1_500},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 500_000, "organic_score": 85, "verdict": "organic",
             "like_count": 30_000, "comment_count": 1_000},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 1,
             "view_count": 2_000_000, "organic_score": 25, "verdict": "likely_paid",
             "like_count": 10_000, "comment_count": 100},
            # plave D-30: 1 insufficient_data — excluded from ratios but
            # counted in video_count
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 50, "organic_score": None, "verdict": "insufficient_data",
             "like_count": 1, "comment_count": 0},
        ],
    })
    result = build_summary(client)
    sqls = [s[0] for s in result.statements]
    params_list = [s[1] for s in result.statements]
    assert len(result.statements) == 1
    assert "INSERT INTO debut_window_organicity_summary" in sqls[0]
    # V2 params (15 cols): group_key, bucket, video_count, long_count, short_count,
    #         score_mean, score_mean_long, score_mean_short, score_mean_simple,
    #         organic_ratio, suspect_ratio, likely_ratio,
    #         total_views, total_engagement, computed_at
    p = params_list[0]
    assert p[0] == "plave"
    assert p[1] == "D-30"
    assert p[2] == 4               # total video_count
    assert p[3] == 3               # long_form_count (3 long, of which 1 insufficient)
    assert p[4] == 1               # short_form_count
    # View-weighted mean over scored videos (exclude None):
    #   (80*1M + 85*0.5M + 25*2M) / (1M + 0.5M + 2M) = 172.5M / 3.5M = 49.29
    assert abs(p[5] - 49.29) < 0.5
    # score_mean_long over scored long (vid1, vid2 — vid4 is insufficient):
    #   (80*1M + 85*0.5M) / 1.5M = 122.5M / 1.5M = 81.67
    assert abs(p[6] - 81.67) < 0.5
    # score_mean_short over scored short (vid3 only): 25
    assert abs(p[7] - 25.0) < 0.5
    # score_mean_simple (unweighted) over scored: (80+85+25)/3 = 63.33
    assert abs(p[8] - 63.33) < 0.5
    # Ratios over scored videos (3, excluding insufficient_data)
    assert abs(p[9] - 2/3) < 0.01  # organic_ratio
    assert abs(p[10] - 0.0) < 0.01  # suspect_ratio
    assert abs(p[11] - 1/3) < 0.01  # likely_paid_ratio
    assert p[12] == 1_000_000 + 500_000 + 2_000_000 + 50  # total_views
    assert p[13] == 50_000 + 1_500 + 30_000 + 1_000 + 10_000 + 100 + 1 + 0  # total_engagement
