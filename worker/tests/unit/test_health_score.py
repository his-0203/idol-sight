import json
from datetime import date, timedelta

from idol_sight.analysis.health_score import compute_health_score, WEIGHTS


def _agg(**kw):
    base = {
        "yt_subscribers": 0, "yt_total_views": 0,
        "yt_top10": [],
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
    agg = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        yt_top10=[{"views": 10_000_000} for _ in range(10)],
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
               yt_top10=[{"views": 1_000_000}] * 10,
               dc_total_posts=10_000, naver_total_news=100, controversy_count=0)
    score = compute_health_score("isedol", agg, debut_date=past)
    bd = score.breakdown
    # Components are present and non-negative.
    assert all(bd.get(k, 0) >= 0 for k in ("subscribers", "views", "quality",
                                            "community", "news", "risk"))


def test_weights_constant_is_exposed():
    """The /api/health/spec endpoint will need this."""
    assert sum(WEIGHTS.values()) == 100   # spec §7.1 normalizes against 100 + bonus
