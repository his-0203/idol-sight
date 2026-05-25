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


def test_window_buckets_are_11_non_overlapping_ranges():
    """V3.1 (2026-05-25): organicity 전 영상 적용. Pre(-∞..-61) / Post(61..+∞)
    두 bucket 추가 — 데뷔 ±60일 밖 영상도 organicity 분류. V3 의 9 bucket
    (D-60 ~ D+60) 유지 + Pre/Post 가 ±60 밖 catch.

    CompetitorOrganicityBar 의 V2.22 7 bucket + 2 legacy (D-60/D+60) 패턴
    은 Pre/Post 라벨을 ALL_BUCKETS 에 안 포함시켜 자동 ignore 한다.
    DebutWindowVideoTable 의 5 탭 UI 도 마찬가지.
    """
    assert len(WINDOW_BUCKETS) == 11
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == [
        "Pre", "D-60", "D-30", "D-20", "D-10", "D-Day",
        "D+10", "D+20", "D+30", "D+60", "Post",
    ]
    flat = [(lo, hi) for _, lo, hi in WINDOW_BUCKETS]
    assert flat == [
        (-999999, -61),
        (-60, -31),
        (-30, -21),
        (-20, -11),
        (-10,  -2),
        ( -1,   1),
        (  2,  10),
        ( 11,  20),
        ( 21,  30),
        ( 31,  60),
        ( 61, 999999),
    ]


@pytest.mark.parametrize("days,expected", [
    (-30, "D-30"),
    (-21, "D-30"),
    (-20, "D-20"),
    (-15, "D-20"),
    (-11, "D-20"),
    (-10, "D-10"),
    (-2,  "D-10"),
    (-1,  "D-Day"),
    (0,   "D-Day"),
    (1,   "D-Day"),
    (2,   "D+10"),
    (10,  "D+10"),
    (11,  "D+20"),
    (20,  "D+20"),
    (21,  "D+30"),
    (30,  "D+30"),
])
def test_bucket_for_returns_correct_bucket(days, expected):
    assert bucket_for(days) == expected


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
    """V2.21 5-tier: organic_strong/organic/borderline/suspect/likely_paid."""
    assert _classify_verdict(100) == "organic_strong"
    assert _classify_verdict(85)  == "organic_strong"
    assert _classify_verdict(84)  == "organic"
    assert _classify_verdict(70)  == "organic"
    assert _classify_verdict(69)  == "borderline"
    assert _classify_verdict(55)  == "borderline"
    assert _classify_verdict(54)  == "suspect"
    assert _classify_verdict(40)  == "suspect"
    assert _classify_verdict(39)  == "likely_paid"
    assert _classify_verdict(0)   == "likely_paid"


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
    # V2.21: 100 score is now organic_strong (≥85)
    assert breakdown["verdict"] == "organic_strong"
    assert dict(breakdown["weights"]) == {"engagement": 0.625, "balance": 0.375}
    assert breakdown["velocity_coherence_score"] is None
    # No suspicion causes on organic_strong; no viral_real because velocity is None
    assert breakdown["causes"] == []


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
    # V2.21 cause tagging: ER < floor (engagement_weak) + velocity coherence = 20 (paid_burst).
    # like_farm not attached: balance_score=80 (>=60 floor), so signal is not below
    # the suspicion threshold even though ratio=90 is in penalty zone.
    assert set(breakdown["causes"]) == {"engagement_weak", "paid_burst"}


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


def test_build_video_organicity_scores_all_videos_emits_upserts():
    """V3.1: Reads all videos with a debut_date, scores each (including ±60
    outside via Pre/Post buckets), returns upsert statements."""
    # Two miiwan videos: one inside debut window (D-15), one outside (D-166).
    # V2.22: D-15 lands in D-20 (-20..-11) under the 7-bucket scheme.
    # V3.1: D-166 lands in Pre (-∞..-61) instead of being skipped.
    client = _client({
        "FROM youtube_videos": [
            {
                "video_id": "vid_inside",
                "group_key": "miiwan",
                "is_short": 0,
                "published_at": "2026-06-01T00:00:00Z",  # D-15 → D-20 bucket
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
                "published_at": "2026-01-01T00:00:00Z",  # ~D-166 → Pre bucket
                "view_count": 100_000,
                "like_count": 5_000,
                "comment_count": 100,
                "viral_velocity_ratio": None,
                "debut_date": "2026-06-16",
            },
        ],
    })
    result = build_video_organicity(client)

    # V3.1: both videos get upserts (Pre bucket catches outside video)
    sqls = [s[0] for s in result.statements]
    params_list = [s[1] for s in result.statements]
    assert len(result.statements) == 2
    for sql in sqls:
        assert "INSERT INTO debut_window_video_organicity" in sql
        assert "ON CONFLICT(video_id) DO UPDATE" in sql

    # Map video_id → params for unordered assertion
    by_id = {p[0]: p for p in params_list}
    assert set(by_id) == {"vid_inside", "vid_outside"}

    # In-window video lands in D-20 bucket
    assert "D-20" in by_id["vid_inside"]
    # Out-of-window video lands in Pre bucket (V3.1)
    assert "Pre" in by_id["vid_outside"]

    # signal_breakdown is JSON on both
    for params in params_list:
        breakdown_json = next(
            p for p in params if isinstance(p, str) and p.startswith("{")
        )
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
    """Aggregates per (group_key, window_bucket). V2.21 5-tier ratios.
    Excludes insufficient_data from ratio denominator. Score mean is view-weighted."""
    client = _client({
        "FROM debut_window_video_organicity": [
            # plave D-30: 5-tier coverage in scored videos
            #   vid1 organic_strong (90), vid2 organic (75), vid3 borderline (60),
            #   vid4 suspect (45), vid5 likely_paid (25), vid6 insufficient_data
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 1_000_000, "organic_score": 90, "verdict": "organic_strong",
             "like_count": 60_000, "comment_count": 2_000},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 500_000, "organic_score": 75, "verdict": "organic",
             "like_count": 30_000, "comment_count": 1_000},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 400_000, "organic_score": 60, "verdict": "borderline",
             "like_count": 12_000, "comment_count": 600},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 1,
             "view_count": 800_000, "organic_score": 45, "verdict": "suspect",
             "like_count": 4_000, "comment_count": 50},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 1,
             "view_count": 2_000_000, "organic_score": 25, "verdict": "likely_paid",
             "like_count": 10_000, "comment_count": 100},
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
    # V2.21 params (17 cols): group_key, bucket, video_count, long_count, short_count,
    #         score_mean, _mean_long, _mean_short, _mean_simple,
    #         strong_ratio, organic_ratio, borderline_ratio, suspect_ratio, likely_ratio,
    #         total_views, total_engagement, computed_at
    p = params_list[0]
    assert p[0] == "plave"
    assert p[1] == "D-30"
    assert p[2] == 6               # total video_count
    assert p[3] == 4               # long_form_count (vid1,2,3,6)
    assert p[4] == 2               # short_form_count (vid4,5)
    # View-weighted mean over scored videos (5, excluding vid6):
    #   weights sum = 1M+0.5M+0.4M+0.8M+2M = 4.7M
    #   weighted score = 90*1M + 75*0.5M + 60*0.4M + 45*0.8M + 25*2M
    #                  = 90M + 37.5M + 24M + 36M + 50M = 237.5M
    #   mean = 237.5M / 4.7M ≈ 50.53
    assert abs(p[5] - 50.53) < 0.5
    # score_mean_long over scored long (vid1,2,3): (90*1M+75*0.5M+60*0.4M) / 1.9M
    #   = (90M+37.5M+24M)/1.9M = 151.5M / 1.9M ≈ 79.74
    assert abs(p[6] - 79.74) < 0.5
    # score_mean_short over scored short (vid4,5): (45*0.8M+25*2M)/2.8M
    #   = (36M+50M)/2.8M = 86M/2.8M ≈ 30.71
    assert abs(p[7] - 30.71) < 0.5
    # score_mean_simple (unweighted, scored only): (90+75+60+45+25)/5 = 59.0
    assert abs(p[8] - 59.0) < 0.5
    # 5-tier ratios over scored videos (5)
    assert abs(p[9]  - 1/5) < 0.01  # organic_strong_ratio
    assert abs(p[10] - 1/5) < 0.01  # organic_ratio
    assert abs(p[11] - 1/5) < 0.01  # borderline_ratio
    assert abs(p[12] - 1/5) < 0.01  # suspect_ratio
    assert abs(p[13] - 1/5) < 0.01  # likely_paid_ratio
    assert p[14] == 1_000_000 + 500_000 + 400_000 + 800_000 + 2_000_000 + 50
    assert p[15] == (
        60_000 + 2_000 + 30_000 + 1_000 + 12_000 + 600
        + 4_000 + 50 + 10_000 + 100 + 1 + 0
    )


def test_compute_causes_attaches_viral_real_on_organic_strong():
    """V2.21: viral_real cause attaches even to top-tier verdict (rare but real
    viral videos benefit from explicit tagging)."""
    video = {
        "is_short": False,
        "view_count": 5_000_000,
        "like_count": 350_000,   # er = ~7%
        "comment_count": 15_000, # ratio = ~23 (long normal)
        "viral_velocity_ratio": 4.0,  # viral + high ER → coherence 100
    }
    score, breakdown = compute_organic_score(video)
    assert breakdown["verdict"] == "organic_strong"
    assert "viral_real" in breakdown["causes"]
    # No suspicion causes on organic_strong
    for c in ("engagement_weak", "comment_farm", "like_farm", "paid_burst"):
        assert c not in breakdown["causes"]


@pytest.mark.parametrize("setup,expected_causes", [
    # comment_farm: long video with very low ratio (likes << comments)
    (
        {"is_short": False, "view_count": 100_000, "like_count": 200,
         "comment_count": 800, "viral_velocity_ratio": None},
        {"comment_farm"},  # ratio = 0.25, well under long lo=10
    ),
    # like_farm: long video with extreme like-skew, low ER
    (
        {"is_short": False, "view_count": 1_000_000, "like_count": 50_000,
         "comment_count": 50, "viral_velocity_ratio": None},
        # ratio=1000, ER=5%. balance=0 (penalty extreme). engagement=80 (5%).
        # No-velocity: 0.625*80 + 0.375*0 = 50 → borderline; causes attached.
        {"like_farm"},
    ),
    # paid_burst: viral velocity + dead engagement
    (
        {"is_short": False, "view_count": 2_000_000, "like_count": 4_000,
         "comment_count": 100, "viral_velocity_ratio": 6.0},
        # er=0.2%, ratio=40 (long normal), velocity coherence=20
        # engagement_score=0, balance=100, v=20 → 0.5*0+0.3*100+0.2*20 = 34 → likely_paid
        {"engagement_weak", "paid_burst"},
    ),
])
def test_compute_causes_signal_specific(setup, expected_causes):
    """V2.21 cause tagging — each suspicion category fires on the right signal."""
    _, breakdown = compute_organic_score(setup)
    assert expected_causes.issubset(set(breakdown["causes"])), (
        f"expected {expected_causes} ⊆ {breakdown['causes']} "
        f"(verdict={breakdown['verdict']}, "
        f"e={breakdown.get('engagement_score')}, "
        f"b={breakdown.get('balance_score')}, "
        f"v={breakdown.get('velocity_coherence_score')})"
    )


def test_bucket_for_d_minus_60_range():
    """V3: -60 ~ -31 사이 영상은 D-60 bucket."""
    assert bucket_for(-60) == "D-60"
    assert bucket_for(-45) == "D-60"
    assert bucket_for(-31) == "D-60"


def test_bucket_for_d_plus_60_range():
    """V3: +31 ~ +60 사이 영상은 D+60 bucket."""
    assert bucket_for(31) == "D+60"
    assert bucket_for(45) == "D+60"
    assert bucket_for(60) == "D+60"


def test_bucket_for_d_minus_30_d_minus_60_boundary():
    """V3: -31 → D-60, -30 → D-30. 두 bucket 경계 정확."""
    assert bucket_for(-31) == "D-60"
    assert bucket_for(-30) == "D-30"


def test_bucket_for_d_plus_30_d_plus_60_boundary():
    """V3: +30 → D+30, +31 → D+60. 두 bucket 경계 정확."""
    assert bucket_for(30) == "D+30"
    assert bucket_for(31) == "D+60"


def test_bucket_for_outside_pm_60_maps_to_pre_post():
    """V3.1: ±60 밖 영상은 Pre/Post bucket 로 매핑 (V3 의 None 반환 폐지)."""
    assert bucket_for(-61) == "Pre"
    assert bucket_for(-100) == "Pre"
    assert bucket_for(-999999) == "Pre"
    assert bucket_for(61) == "Post"
    assert bucket_for(100) == "Post"
    assert bucket_for(999999) == "Post"


def test_bucket_for_pre_post_boundary():
    """V3.1: Pre/Post 와 D-60/D+60 의 경계 정확."""
    assert bucket_for(-61) == "Pre"
    assert bucket_for(-60) == "D-60"
    assert bucket_for(60) == "D+60"
    assert bucket_for(61) == "Post"


def test_bucket_for_extreme_values():
    """V3.1: -999999, +999999 같은 극단값도 매핑."""
    assert bucket_for(-999999) == "Pre"
    assert bucket_for(999999) == "Post"


def test_bucket_for_year_old_videos():
    """V3.1: 데뷔 1년 후 영상 (예: ISEDOL 의 2026 영상, 데뷔 2021-12) 매핑."""
    # 데뷔 후 365 + 365*4 = 1825 일 (대충 4년)
    assert bucket_for(1825) == "Post"
    # 데뷔 1년 이전 영상
    assert bucket_for(-365) == "Pre"
