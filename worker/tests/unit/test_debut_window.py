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


def test_window_buckets_are_9_non_overlapping_ranges():
    """V2.34 (2026-05-27): 균등 20일 폭 통일. 7 named bucket (D-60/D-40/D-20/
    D-Day/D+20/D+40/D+60) + Pre/Post catch-all = 9 bucket. 모든 named bucket
    이 정확히 20일 폭, 인접 bucket 경계 연속, 데뷔 ±69일 안에 빈 구간 없음.

    이전 V3.1 (2026-05-25) 의 11 bucket 은 D-60/D+60 (30일) / D-30~D+30
    (10일) / D-Day (3일) 의 비대칭 폭이었으나 균등 폭으로 통일.
    """
    assert len(WINDOW_BUCKETS) == 9
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == [
        "Pre", "D-60", "D-40", "D-20", "D-Day",
        "D+20", "D+40", "D+60", "Post",
    ]
    flat = [(lo, hi) for _, lo, hi in WINDOW_BUCKETS]
    assert flat == [
        (-999999, -71),
        (-70, -51),
        (-50, -31),
        (-30, -11),
        (-10,   9),
        ( 10,  29),
        ( 30,  49),
        ( 50,  69),
        ( 70, 999999),
    ]
    # 균등 20일 폭 회귀 가드 — named bucket 7개 모두 hi-lo+1 == 20.
    named = [b for b in WINDOW_BUCKETS if b[0] not in ("Pre", "Post")]
    assert all(hi - lo + 1 == 20 for _, lo, hi in named)


@pytest.mark.parametrize("days,expected", [
    # D-60: -70..-51
    (-70, "D-60"),
    (-60, "D-60"),
    (-51, "D-60"),
    # D-40: -50..-31
    (-50, "D-40"),
    (-40, "D-40"),
    (-31, "D-40"),
    # D-20: -30..-11
    (-30, "D-20"),
    (-20, "D-20"),
    (-11, "D-20"),
    # D-Day: -10..+9 (centered on debut)
    (-10, "D-Day"),
    (-1,  "D-Day"),
    (0,   "D-Day"),
    (1,   "D-Day"),
    (9,   "D-Day"),
    # D+20: 10..29
    (10,  "D+20"),
    (20,  "D+20"),
    (29,  "D+20"),
    # D+40: 30..49
    (30,  "D+40"),
    (40,  "D+40"),
    (49,  "D+40"),
    # D+60: 50..69
    (50,  "D+60"),
    (60,  "D+60"),
    (69,  "D+60"),
    # Pre / Post catch-all
    (-100, "Pre"),
    (-71,  "Pre"),
    (70,   "Post"),
    (200,  "Post"),
])
def test_bucket_for_returns_correct_bucket(days, expected):
    assert bucket_for(days) == expected


@pytest.mark.parametrize("er,is_short,expected", [
    # V2 long-form: 0pt at 1.0%, 100pt at 6.0% (unchanged)
    (0.000, False, 0),     # below floor
    (0.010, False, 0),     # exact floor
    (0.035, False, 50),    # midpoint (1.0+6.0)/2 = 3.5%
    (0.060, False, 100),   # exact ceiling
    (0.100, False, 100),   # above ceiling clamps
    # V2.37 shorts: 0pt at 0.5%, 100pt at 9.0% (ER as a gentle *strength* curve,
    # floor deliberately low so weak-but-alive engagement isn't auto-zeroed).
    (0.000, True, 0),      # below floor
    (0.005, True, 0),      # exact floor
    (0.0008, True, 0),     # MV-teaser dead engagement → 0
    (0.0091, True, 5),     # 꿍싯꿍싯 0.91% → weak but non-zero (was 0 under V2)
    (0.0475, True, 50),    # midpoint (0.5+9.0)/2 = 4.75%
    (0.090, True, 100),    # exact ceiling
    (0.150, True, 100),    # above ceiling clamps
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
    # V2.37 shorts normal zone: 15-78 returns 100 (recalibrated to live p10-p90)
    (15.0,  True, 100),
    (41.0,  True, 100),   # live median
    (78.0,  True, 100),
    # Shorts below 15: -5/unit (comment-farm)
    (10.0, True, 75),     # 100 - (15-10)*5 = 75
    (4.0,  True, 45),     # 100 - (15-4)*5 = 45 (MV-teaser comment-heavy)
    (0.0,  True, 25),     # 100 - 15*5 = 25
    # Shorts above 78: -0.4/unit (like-farm)
    (100.0, True, 91),    # 100 - (100-78)*0.4 = 91.2
    (200.0, True, 51),    # 100 - (200-78)*0.4 = 51.2
    (600.0, True, 0),     # clamps to 0
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


def test_short_organic_score_weak_engagement_normal_balance_is_borderline():
    """V2.37 (2026-06-05) headline regression — the MiiWAN 꿍싯꿍싯 Short.

    Real D1 values: 38,094 views / 328 likes / 19 comments → ER 0.91%,
    like:comment 17.3. Engagement is weak (below the live p10 of 2.65%) but the
    like:comment balance sits squarely inside the normal zone (15-78) — i.e.
    cold/passive reach, NOT a manipulation signature. The V2.37 Shorts model
    (balance-weighted 0.6, velocity dropped) lands it in borderline with only an
    engagement_weak cause — it must NOT be accused of being paid, and must NOT be
    excluded as insufficient_data (the V2.36 absolute-view gate is gone)."""
    video = {
        "is_short": True,
        "view_count": 38_094,
        "like_count": 328,
        "comment_count": 19,
        "viral_velocity_ratio": 18.565,  # ignored for Shorts in V2.37
    }
    score, breakdown = compute_organic_score(video)
    # e=5 (ER 0.91%), b=100 (lcr 17.3 in zone) → 0.4*5 + 0.6*100 = 62
    assert score == 62
    assert breakdown["verdict"] == "borderline"
    assert breakdown["velocity_coherence_score"] is None
    assert dict(breakdown["weights"]) == {"engagement": 0.4, "balance": 0.6}
    assert set(breakdown["causes"]) == {"engagement_weak"}
    assert "paid_burst" not in breakdown["causes"]


def test_short_organic_score_dead_engagement_is_likely_paid():
    """V2.37: the MV-teaser pattern (operator-confirmed paid promotion on the
    PLUMA teaser / Piece series). High views, near-dead engagement (ER ~0.08%),
    comment-heavy balance (lcr ~4). This SHOULD be flagged — dead engagement +
    abnormal balance is the genuine paid/cold-traffic signature."""
    video = {
        "is_short": True,
        "view_count": 200_000,
        "like_count": 120,       # ER 0.075% → e_score 0
        "comment_count": 30,     # lcr 4.0 → comment-farm zone
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # e=0, b=100-(15-4)*5=45 → 0.4*0 + 0.6*45 = 27
    assert score == 27
    assert breakdown["verdict"] == "likely_paid"
    assert set(breakdown["causes"]) == {"engagement_weak", "comment_farm"}


def test_short_organic_score_small_healthy_short_is_organic_not_excluded():
    """V2.37: a small Short with healthy ratios is scored organic, NOT excluded.
    Under the V2.36 absolute-view gate every sub-100K Short was held as
    insufficient_data — discarding good organic signal (the bulk of MiiWAN's
    pre-debut Shorts sit at ER 3-9%, dead in the normal range)."""
    video = {
        "is_short": True,
        "view_count": 1_796,     # well under the old 100K gate
        "like_count": 105,       # ER 6.1%
        "comment_count": 5,      # lcr 21 (in zone)
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # e=66 (ER 6.1%), b=100 → 0.4*66 + 0.6*100 = 86
    assert score == 86
    assert breakdown["verdict"] == "organic_strong"


def test_short_organic_score_like_farm_caught_despite_decent_er():
    """V2.37: balance is the primary authenticity axis — a like-farm (extreme
    like:comment) is flagged even with a decent engagement rate, because the
    balance weight (0.6) dominates."""
    video = {
        "is_short": True,
        "view_count": 100_000,
        "like_count": 5_000,     # ER 5.0% → e_score 53
        "comment_count": 5,      # lcr 1000 → like-farm, b_score 0
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # e=53, b=0 → 0.4*53 + 0.6*0 = 21
    assert score == 21
    assert breakdown["verdict"] == "likely_paid"
    assert "like_farm" in breakdown["causes"]
    # engagement is fine here — the farm, not weak ER, is the signal
    assert "engagement_weak" not in breakdown["causes"]


def test_short_zero_comment_not_flagged_like_farm():
    """V2.37: a healthy small Short with strong likes but 0 comments (normal for
    Shorts — tap-like, no comment) must NOT read as a like-farm. Without the
    guard, like_comment_ratio = likes/1 (degenerate) drives balance down and the
    balance-dominant weighting flags it likely_paid."""
    video = {
        "is_short": True,
        "view_count": 4_000,
        "like_count": 300,      # ER 7.5%, healthy
        "comment_count": 0,     # tap-likes, no comments
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # e=82 (ER 7.5%), b forced to 100 (0-comment neutral) → 0.4*82 + 0.6*100 = 93
    assert score == 93
    assert breakdown["verdict"] == "organic_strong"
    assert "like_farm" not in breakdown["causes"]
    assert breakdown["balance_basis"] == "zero_comment"


def test_short_low_comment_low_view_balance_neutralized_fixes_cliff():
    """V2.39 (2026-06-07) headline regression — the '댓글 1개 절벽'.

    A healthy small Short (4K views / 300 likes) with just 1 comment had its
    like_comment_ratio explode to 300, tripping the like-farm penalty and
    cratering the balance-dominant score to 39 (likely_paid) — even though the
    same Short with 0 comments scored 93 (organic_strong). Ground-truth: every
    MiiWAN Short except the PLUMA teaser is organic, so this was a pure false
    positive. The low-comment guard neutralizes balance below
    BALANCE_MIN_COMMENTS_SHORT when the Short is also low-view, so it scores on
    engagement alone: e=82 (ER ~7.5%), b=100 → 0.4*82 + 0.6*100 = 93."""
    video = {
        "is_short": True,
        "view_count": 4_000,
        "like_count": 300,
        "comment_count": 1,     # was ratio 300 → like-farm cliff under V2.37
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score == 93
    assert breakdown["verdict"] == "organic_strong"
    assert breakdown["balance_basis"] == "insufficient_comments"
    assert "like_farm" not in breakdown["causes"]


def test_short_high_view_low_comment_balance_still_judged():
    """V2.39: the low-comment guard must NOT protect high-view Shorts —
    high views + few comments + the resulting near-dead ER is the genuine
    cold-traffic/paid signature, so balance (farm) detection stays live. The
    existing like_farm fixture (100K / 5000 likes / 5 comments) is exactly this
    case: above BALANCE_LOW_VIEW_CEIL_SHORT, so balance is judged on the ratio
    (1000 → b=0) and it stays likely_paid at 21, NOT rescued by the guard."""
    video = {
        "is_short": True,
        "view_count": 100_000,
        "like_count": 5_000,
        "comment_count": 5,     # < MIN comments, but high-view → not protected
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score == 21
    assert breakdown["verdict"] == "likely_paid"
    assert breakdown["balance_basis"] == "ratio"
    assert "like_farm" in breakdown["causes"]


@pytest.mark.parametrize(
    "view_count,comment_count,expect_protected",
    [
        (49_999, 1, True),    # below view ceil → protected
        (50_000, 1, False),   # at view ceil → not protected (boundary)
        (4_000,  9, True),    # below comment min → protected
        (4_000, 10, False),   # at comment min → not protected (boundary)
    ],
)
def test_short_low_comment_guard_boundaries(view_count, comment_count, expect_protected):
    """V2.39 boundary pins: guard fires for comment_count <
    BALANCE_MIN_COMMENTS_SHORT (10) AND view_count < BALANCE_LOW_VIEW_CEIL_SHORT
    (50_000). Both are strict-less-than, so the threshold value itself is NOT
    protected. Use a like-heavy short (lcr well above the p90 ceiling) so the
    protected/unprotected split is visible in balance_basis."""
    video = {
        "is_short": True,
        "view_count": view_count,
        "like_count": 600,       # lcr 600/comment → far above the 78 ceiling
        "comment_count": comment_count,
        "viral_velocity_ratio": None,
    }
    _, breakdown = compute_organic_score(video)
    if expect_protected:
        assert breakdown["balance_basis"] == "insufficient_comments"
    else:
        assert breakdown["balance_basis"] == "ratio"


def test_short_normal_comment_count_balance_basis_is_ratio():
    """V2.39: a Short with enough comments is judged on the ratio as before —
    balance_basis defaults to 'ratio'."""
    video = {
        "is_short": True,
        "view_count": 10_000,
        "like_count": 500,       # ER 5.1%, lcr 25 (in zone)
        "comment_count": 20,     # >= MIN comments
        "viral_velocity_ratio": None,
    }
    _, breakdown = compute_organic_score(video)
    assert breakdown["balance_basis"] == "ratio"


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
                "published_at": "2026-06-01T00:00:00Z",  # D-15 → D-15 bucket (V2.34)
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

    # In-window video lands in D-20 bucket (V2.34 균등 20일 폭, -15 ∈ -30..-11)
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
    # statements[0] is the table-clearing DELETE (see
    # test_build_summary_prunes_stale_rows_with_leading_delete); the single
    # group/bucket here produces exactly one upsert after it.
    assert len(result.statements) == 2
    upserts = [s for s in result.statements
               if "INSERT INTO debut_window_organicity_summary" in s[0]]
    assert len(upserts) == 1
    # V2.21 params (17 cols): group_key, bucket, video_count, long_count, short_count,
    #         score_mean, _mean_long, _mean_short, _mean_simple,
    #         strong_ratio, organic_ratio, borderline_ratio, suspect_ratio, likely_ratio,
    #         total_views, total_engagement, computed_at
    p = upserts[0][1]
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


def test_build_summary_prunes_stale_rows_with_leading_delete():
    """build_summary is a full recompute from the per-video table, so it must
    emit a leading ``DELETE FROM debut_window_organicity_summary`` before the
    rebuild upserts. Otherwise (group, bucket) rows that emptied out — e.g.
    when a group's debut_date shifts and all its videos move to the Pre bucket
    — persist with frozen scores and are served by the frontend forever.

    Regression for the wegosix 2026-08-31 debut-shift incident: migration 0074
    moved the debut date but build_summary only upserted, leaving stale
    D-Day/D-20/D+20 summary rows that the main-page DebutWindowKPI kept showing.
    """
    client = _client({
        "FROM debut_window_video_organicity": [
            # After the debut shift all wegosix videos land in Pre.
            {"group_key": "wegosix", "window_bucket": "Pre", "is_short": 0,
             "view_count": 10_000, "organic_score": 80, "verdict": "organic_strong",
             "like_count": 500, "comment_count": 20},
        ],
    })
    result = build_summary(client)
    sqls = [s[0] for s in result.statements]
    # First statement clears the whole summary table.
    assert sqls[0].strip().upper().startswith(
        "DELETE FROM DEBUT_WINDOW_ORGANICITY_SUMMARY"
    )
    # The DELETE carries no parameters.
    assert result.statements[0][1] == []
    # …and the rebuild upserts follow it.
    assert any("INSERT INTO debut_window_organicity_summary" in s for s in sqls)


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
    """V2.34: -70 ~ -51 사이 영상은 D-60 bucket (20일 폭)."""
    assert bucket_for(-70) == "D-60"
    assert bucket_for(-60) == "D-60"
    assert bucket_for(-51) == "D-60"


def test_bucket_for_d_plus_60_range():
    """V2.34: +50 ~ +69 사이 영상은 D+60 bucket (20일 폭)."""
    assert bucket_for(50) == "D+60"
    assert bucket_for(60) == "D+60"
    assert bucket_for(69) == "D+60"


def test_bucket_for_d_minus_40_d_minus_60_boundary():
    """V2.34: -51 → D-60, -50 → D-40. 두 bucket 경계 정확 (20일 폭)."""
    assert bucket_for(-51) == "D-60"
    assert bucket_for(-50) == "D-40"


def test_bucket_for_d_plus_40_d_plus_60_boundary():
    """V2.34: +49 → D+40, +50 → D+60. 두 bucket 경계 정확."""
    assert bucket_for(49) == "D+40"
    assert bucket_for(50) == "D+60"


def test_bucket_for_outside_pm_69_maps_to_pre_post():
    """V2.34: ±69 밖 영상은 Pre/Post bucket 로 매핑 (20일 폭 7 bucket 의 catch-all)."""
    assert bucket_for(-71) == "Pre"
    assert bucket_for(-100) == "Pre"
    assert bucket_for(-999999) == "Pre"
    assert bucket_for(70) == "Post"
    assert bucket_for(100) == "Post"
    assert bucket_for(999999) == "Post"


def test_bucket_for_pre_post_boundary():
    """V2.34: Pre/Post 와 D-60/D+60 의 경계 정확."""
    assert bucket_for(-71) == "Pre"
    assert bucket_for(-70) == "D-60"
    assert bucket_for(69) == "D+60"
    assert bucket_for(70) == "Post"


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
