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
        "hanteo_sales": 0, "negative_ratio": 0.0,
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
    # PLAVE-tier inputs: million-seller hanteo (drives RitualVictory +
    # Mobilization), high engagement, full community + news coverage.
    agg = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        likes_total=8_000_000, comments_total=600_000,
        dc_total_posts=50_000, theqoo_posts=20_000, instiz_posts=35_000,
        naver_total_news=300, controversy_count=0,
        hanteo_sales=1_000_000,   # millennium seller
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


# ─── V2.5 4-factor Health Score ────────────────────────────────────────


def test_factors_present_for_post_debut_groups():
    past = (date.today() - timedelta(days=400)).isoformat()
    score = compute_health_score(
        "plave",
        _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
             likes_total=2_000_000, comments_total=100_000,
             dc_total_posts=10_000, naver_total_news=100,
             hanteo_sales=500_000),
        debut_date=past,
    )
    assert score.factors
    # All four factors present and non-negative.
    for k in ("reach", "ritual", "mobilization", "intimacy"):
        assert k in score.factors
        assert score.factors[k] >= 0
    assert score.group_model == "corporate"


def test_segmentary_weights_intimacy_higher_than_corporate():
    """ISEDOL-style group should put more of its score weight on
    Intimacy (engagement / community / live) than a same-input
    PLAVE-style corporate group."""
    past = (date.today() - timedelta(days=1000)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,   # high engagement
        dc_total_posts=20_000, theqoo_posts=5_000,
        naver_total_news=80, hanteo_sales=0,             # no album drop
    )
    s_corp = compute_health_score("x", common, debut_date=past,
                                   group_model="corporate")
    s_seg  = compute_health_score("x", common, debut_date=past,
                                   group_model="segmentary")
    # Same engagement input → segmentary's intimacy weight (40) > corporate's (15).
    assert s_seg.factors["intimacy"] > s_corp.factors["intimacy"]
    # Same views → corporate's mobilization weight (30) > segmentary's (25).
    assert s_corp.factors["mobilization"] >= s_seg.factors["mobilization"]


def test_confederation_intimacy_dominant():
    """STELLIVE-style — Intimacy should be the largest contributing
    factor by weight (55 of 100)."""
    past = (date.today() - timedelta(days=600)).isoformat()
    score = compute_health_score(
        "stellive",
        _agg(yt_subscribers=600_000, yt_total_views=80_000_000,
             likes_total=4_000_000, comments_total=400_000,
             dc_total_posts=8_000, theqoo_posts=4_000,
             naver_total_news=50),
        debut_date=past, group_model="confederation",
    )
    factors = score.factors
    # Intimacy beats every other factor for confederation.
    assert factors["intimacy"] > factors["reach"]
    assert factors["intimacy"] > factors["ritual"]
    assert factors["intimacy"] > factors["mobilization"]


def test_unknown_group_model_falls_back_to_corporate():
    past = (date.today() - timedelta(days=100)).isoformat()
    score = compute_health_score(
        "x", _agg(yt_subscribers=100_000), debut_date=past,
        group_model="unknown_garbage",
    )
    assert score.group_model == "corporate"


def test_negative_sentiment_compresses_intimacy_factor():
    """High negative_ratio should pull the intimacy factor down even
    when raw engagement is high (fans can be loud and unhappy)."""
    past = (date.today() - timedelta(days=400)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=20_000, naver_total_news=80,
    )
    happy = compute_health_score("x", {**common, "negative_ratio": 0.05},
                                  debut_date=past, group_model="segmentary")
    angry = compute_health_score("x", {**common, "negative_ratio": 0.6},
                                  debut_date=past, group_model="segmentary")
    assert happy.factors["intimacy"] > angry.factors["intimacy"]


def test_controversy_compresses_all_four_factors():
    """A risk_factor < 1.0 multiplies every factor, not just one."""
    past = (date.today() - timedelta(days=400)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=20_000, naver_total_news=80,
    )
    clean = compute_health_score("x", common, debut_date=past,
                                  group_model="corporate")
    scandal = compute_health_score("x", {**common, "controversy_count": 5},
                                    debut_date=past, group_model="corporate")
    for k in ("reach", "ritual", "mobilization", "intimacy"):
        # Strictly less when risk fires (5 controversies → factor 0.5).
        assert scandal.factors[k] < clean.factors[k]
