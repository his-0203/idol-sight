"""V2.53 Organic Trust Layer — organic_confidence 단위 테스트."""
from idol_sight.analysis.organic_confidence import (
    CONFIDENCE_PRIOR,
    compute_organic_confidence,
    load_organic_confidence,
)


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=None):
        return self.rows


def test_bthd_fixture_regression():
    """BTHD 2026-07-20 실측 분포(organic 3 / borderline 6 / suspect 5 /
    likely_paid 8) → mean 0.4727..., shrinkage 후 0.506."""
    verdicts = (["organic"] * 3 + ["borderline"] * 6
                + ["suspect"] * 5 + ["likely_paid"] * 8)
    assert compute_organic_confidence(verdicts) == 0.506


def test_all_organic_is_shrunk_toward_prior():
    # n=2 전부 organic: (2*1.0 + 3*0.75) / 5 = 0.85 — 만점 방지
    assert compute_organic_confidence(["organic", "organic_strong"]) == 0.85


def test_all_paid_is_shrunk_up():
    # n=1 likely_paid: (0.15 + 2.25) / 4 = 0.6
    assert compute_organic_confidence(["likely_paid"]) == 0.6


def test_empty_means_no_discount():
    assert compute_organic_confidence([]) == 1.0


def test_unknown_and_insufficient_verdicts_ignored():
    # 알 수 없는 verdict 는 표본에서 제외 — 전부 미지면 무할인
    assert compute_organic_confidence(["insufficient_data", "???"]) == 1.0


def test_load_groups_by_key():
    client = FakeClient([
        {"group_key": "a", "verdict": "organic"},
        {"group_key": "a", "verdict": "likely_paid"},
        {"group_key": "b", "verdict": "organic"},
    ])
    conf = load_organic_confidence(client)
    # a: mean 0.575 → (2*0.575+2.25)/5 = 0.68 / b: (1.0+2.25)/4 = 0.8125
    # round(0.8125, 3) == 0.812 (Python round — banker's rounding으로 내림)
    assert conf == {"a": 0.68, "b": 0.812}


def test_prior_constant():
    assert CONFIDENCE_PRIOR == 0.75
