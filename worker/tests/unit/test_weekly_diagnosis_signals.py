"""weekly_diagnosis_signals — 순수 함수 단위 테스트."""

import math
from idol_sight.analysis.weekly_diagnosis_signals import cohort_z_score
from idol_sight.analysis.weekly_diagnosis_signals import wow_ratio, metric_delta


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
