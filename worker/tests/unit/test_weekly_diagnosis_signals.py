"""weekly_diagnosis_signals — 순수 함수 단위 테스트."""

import math
from idol_sight.analysis.weekly_diagnosis_signals import cohort_z_score
from idol_sight.analysis.weekly_diagnosis_signals import wow_ratio, metric_delta
from idol_sight.analysis.weekly_diagnosis_signals import (
    engagement_rate_from_agg, engagement_rate_wow_drop,
    views_per_sub, views_per_sub_wow_drop,
)
from idol_sight.analysis.weekly_diagnosis_signals import organicity_paid_ratio
from idol_sight.analysis.weekly_diagnosis_signals import (
    reactivity_dominant_platform, REACTIVITY_DOMINANCE_THRESHOLD,
)


def test_cohort_z_score_basic():
    z = cohort_z_score(value=10.0, cohort=[1.0, 2.0, 3.0, 4.0, 5.0])
    # mean=3, sd≈1.581, z=(10-3)/1.581 ≈ 4.43
    assert math.isclose(z, 4.428, abs_tol=0.01)


def test_cohort_z_score_zero_std():
    # 모든 값이 같으면 sd=0 → z=0 (중립).
    z = cohort_z_score(value=10.0, cohort=[5.0, 5.0, 5.0])
    assert z == 0.0


def test_cohort_z_score_empty():
    assert cohort_z_score(value=10.0, cohort=[]) == 0.0


def test_cohort_z_score_single_cohort():
    # 표본 1개로는 stdev 계산 불가 — 중립 0.
    assert cohort_z_score(value=10.0, cohort=[5.0]) == 0.0


def test_wow_ratio_positive_growth():
    assert wow_ratio(now=120, prev=100) == 0.2


def test_wow_ratio_negative_drop():
    assert math.isclose(wow_ratio(now=50, prev=100), -0.5)


def test_wow_ratio_prev_zero_returns_none():
    # 분모 0 → dead signal, None.
    assert wow_ratio(now=100, prev=0) is None


def test_wow_ratio_either_none():
    assert wow_ratio(now=None, prev=100) is None
    assert wow_ratio(now=100, prev=None) is None


def test_metric_delta_basic():
    now = {"subs": 100_000}
    prev = {"subs": 80_000}
    assert metric_delta(now, prev, "subs") == 20_000


def test_metric_delta_handles_null():
    now = {"subs": 100_000}
    prev = {}  # missing key
    assert metric_delta(now, prev, "subs") == 100_000


def test_engagement_rate_from_agg():
    """(likes + 5·comments) / views, health_score 와 동일 계산."""
    agg = {"yt_likes_total": 1000, "yt_comments_total": 200, "yt_total_views": 100_000}
    # (1000 + 5*200) / 100000 = 2000 / 100000 = 0.02
    assert engagement_rate_from_agg(agg) == 0.02


def test_engagement_rate_zero_views():
    assert engagement_rate_from_agg({"yt_total_views": 0}) == 0.0


def test_engagement_rate_wow_drop():
    now = {"yt_likes_total": 500, "yt_comments_total": 100, "yt_total_views": 100_000}
    prev = {"yt_likes_total": 1000, "yt_comments_total": 200, "yt_total_views": 100_000}
    # now ER = 1000/100000 = 0.01, prev ER = 2000/100000 = 0.02
    # drop = (0.01 - 0.02) / 0.02 = -0.5 (50% 하락)
    assert math.isclose(engagement_rate_wow_drop(now, prev), -0.5)


def test_views_per_sub():
    agg = {"yt_total_views": 5_000_000, "yt_subscribers": 100_000}
    assert views_per_sub(agg) == 50.0


def test_views_per_sub_subscribers_zero():
    # subs=0 이면 dead — None 반환
    assert views_per_sub({"yt_total_views": 1_000_000, "yt_subscribers": 0}) is None


def test_views_per_sub_wow_drop_30pct():
    now = {"yt_total_views": 7_000_000, "yt_subscribers": 200_000}    # 35
    prev = {"yt_total_views": 5_000_000, "yt_subscribers": 100_000}   # 50
    # (35 - 50) / 50 = -0.3
    assert math.isclose(views_per_sub_wow_drop(now, prev), -0.3)


def test_organicity_paid_ratio_30pct():
    """suspect + likely_paid 비중. 영상 10개 중 3개가 paid 의심 = 0.3."""
    videos = [
        {"verdict": "organic_strong"},
        {"verdict": "organic"},
        {"verdict": "organic"},
        {"verdict": "organic"},
        {"verdict": "borderline"},
        {"verdict": "borderline"},
        {"verdict": "borderline"},
        {"verdict": "suspect"},
        {"verdict": "suspect"},
        {"verdict": "likely_paid"},
    ]
    assert organicity_paid_ratio(videos) == 0.3


def test_organicity_paid_ratio_excludes_insufficient():
    """insufficient_data 는 분모에서 제외 (debut_window 의 규약)."""
    videos = [
        {"verdict": "organic"},
        {"verdict": "suspect"},
        {"verdict": "insufficient_data"},   # 제외
        {"verdict": "insufficient_data"},   # 제외
    ]
    # 분모 2, paid 1 → 0.5
    assert organicity_paid_ratio(videos) == 0.5


def test_organicity_paid_ratio_empty():
    assert organicity_paid_ratio([]) is None


def test_organicity_paid_ratio_all_insufficient():
    # 분모 0 → None (dead signal)
    videos = [{"verdict": "insufficient_data"}, {"verdict": "insufficient_data"}]
    assert organicity_paid_ratio(videos) is None


def test_reactivity_dominant_naver():
    """reactivity_naver=3.0, 나머지 < 1.3 → 'naver' 반환."""
    agg = {
        "reactivity_dc": 1.0,
        "reactivity_theqoo": 1.2,
        "reactivity_instiz": 1.1,
        "reactivity_naver": 3.0,
        "reactivity_sample": 5,
    }
    name, ratio = reactivity_dominant_platform(agg)
    assert name == "naver"
    assert ratio == 3.0


def test_reactivity_no_dominance():
    """전 플랫폼 비슷한 reactivity → (None, 0.0)."""
    agg = {
        "reactivity_dc": 1.5,
        "reactivity_theqoo": 1.4,
        "reactivity_instiz": 1.6,
        "reactivity_naver": 1.5,
        "reactivity_sample": 5,
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None


def test_reactivity_threshold_not_met():
    """단일 max 가 임계치 < 2.5 → 점등 안 됨."""
    agg = {
        "reactivity_dc": 2.0,    # > 나머지지만 임계치 2.5 미달
        "reactivity_theqoo": 1.0,
        "reactivity_instiz": 1.0,
        "reactivity_naver": 1.0,
        "reactivity_sample": 5,
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None


def test_reactivity_sample_too_low_blocks():
    """sample < 3 → dominance 점등 차단 (메타가드)."""
    agg = {
        "reactivity_dc": 1.0,
        "reactivity_theqoo": 1.0,
        "reactivity_instiz": 1.0,
        "reactivity_naver": 3.0,
        "reactivity_sample": 2,    # 표본 부족
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None
