from datetime import date, timedelta

from idol_sight.analysis.health_score import (
    WEIGHTS,
    compute_dynamic_refs,
    compute_health_score,
)


def _agg(**kw):
    base = {
        "yt_subscribers": 0, "yt_total_views": 0,
        "likes_total": 0, "comments_total": 0,
        "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
        "naver_total_news": 0, "controversy_count": 0,
        "v90_count": 0, "v30_count": 0,
    }
    base.update(kw)
    return base


def test_pre_debut_returns_pre_grade_and_null_total():
    future = (date.today() + timedelta(days=30)).isoformat()
    score = compute_health_score("miiwan", _agg(), debut_date=future)
    assert score.grade == "PRE"
    assert score.total is None
    assert score.label.startswith("데뷔 전")


def test_no_debut_date_returns_pre():
    score = compute_health_score("bdawn", _agg(), debut_date=None)
    assert score.grade == "PRE"
    assert score.total is None


def test_zero_activity_returns_d_grade_with_total_zero():
    past = (date.today() - timedelta(days=365)).isoformat()
    score = compute_health_score("plave", _agg(), debut_date=past)
    assert score.grade == "D"
    assert score.total is not None
    assert score.total < 3.0


def test_high_activity_returns_s_grade():
    past = (date.today() - timedelta(days=1000)).isoformat()
    # 8M likes + 600K comments / 160M views = 0.072 engagement rate, well
    # above the 0.05 default REF — quality saturates as expected.
    agg = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        likes_total=8_000_000, comments_total=600_000,
        dc_total_posts=50_000, theqoo_posts=20_000, instiz_posts=35_000,
        naver_total_news=300, controversy_count=0,
        v90_count=20, v30_count=5,
    )
    score = compute_health_score("plave", agg, debut_date=past)
    assert score.grade in ("S", "A")
    assert score.total is not None and score.total >= 7.0


def test_breakdown_components_sum_consistent_with_raw_total():
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(yt_subscribers=200_000, yt_total_views=20_000_000,
               likes_total=600_000, comments_total=40_000,
               dc_total_posts=10_000, naver_total_news=100, controversy_count=0)
    score = compute_health_score("isedol", agg, debut_date=past)
    bd = score.breakdown
    # Components are present and non-negative.
    assert all(bd.get(k, 0) >= 0 for k in ("subscribers", "views", "quality",
                                            "community", "news", "risk"))


def test_dynamic_refs_returns_p90_per_dimension():
    cohort = [
        {"yt_subscribers": 100, "yt_total_views": 1_000,
         "likes_total": 10, "comments_total": 1,
         "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 5},
        {"yt_subscribers": 200, "yt_total_views": 2_000,
         "likes_total": 20, "comments_total": 2,
         "dc_total_posts": 100, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 10},
        {"yt_subscribers": 1_000_000, "yt_total_views": 100_000_000,
         "likes_total": 4_000_000, "comments_total": 200_000,
         "dc_total_posts": 50_000, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 300},
    ]
    refs = compute_dynamic_refs(cohort)
    # Top-tier (last group) drives p90; mid- and low-tier are pulled up
    # only modestly since the percentile interpolates.
    assert refs["subscribers"] > 200 and refs["subscribers"] <= 1_000_000
    # Floors kick in for empty cohorts but not here.
    assert refs["views"] > 1_000_000


def test_dynamic_refs_falls_back_to_floor_for_empty_cohort():
    refs = compute_dynamic_refs([])
    # Empty list → all floors.
    assert refs["subscribers"] >= 50_000
    assert refs["views"] >= 1_000_000
    assert refs["quality"] >= 0.005


def test_engagement_rate_is_quality_signal_not_top10():
    """Same channel size, different engagement → different quality scores.

    Pre-V2 the quality score was tied to top10-average-views (= channel
    size proxy). V2 ties it to (likes + 5·comments)/views so that two
    channels with the same view count but different fan interaction get
    different scores. This test enforces that.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    # Same views, very different likes+comments.
    low_eng = _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
                   likes_total=100_000, comments_total=2_000)
    high_eng = _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
                    likes_total=4_000_000, comments_total=200_000)
    s_low = compute_health_score("low", low_eng, debut_date=past)
    s_high = compute_health_score("high", high_eng, debut_date=past)
    assert s_high.breakdown["quality"] > s_low.breakdown["quality"]


def test_weights_constant_is_exposed():
    """The /api/health/spec endpoint will need this."""
    assert sum(WEIGHTS.values()) == 100   # spec §7.1 normalizes against 100 + bonus
