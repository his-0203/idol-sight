import pytest
from idol_sight.analysis.loyalty import (
    median, score_from_conversion, ccv_trend, compute_loyalty,
    WINDOW_DAYS, TREND_FLAT_BAND, MIN_BROADCASTS_FOR_TREND,
)


def test_median_odd_even():
    assert median([5.0]) == 5.0
    assert median([3.0, 1.0, 2.0]) == 2.0          # 정렬 후 중앙
    assert median([1.0, 2.0, 3.0, 4.0]) == 2.5     # 짝수 = 평균


def test_median_empty_raises():
    with pytest.raises(ValueError):
        median([])


def test_score_from_conversion_anchors_and_clamps():
    assert score_from_conversion(0.001) == 20.0    # <0.5% 하한 클램프
    assert score_from_conversion(0.005) == 20.0
    assert score_from_conversion(0.015) == 50.0
    assert score_from_conversion(0.03) == 70.0
    assert score_from_conversion(0.06) == 88.0
    assert score_from_conversion(0.20) == 100.0    # 상한 클램프


def test_score_from_conversion_interpolates():
    # 0.5%~1.5% 구간 중간(1.0%) → 20~50 의 중간 = 35
    assert score_from_conversion(0.01) == pytest.approx(35.0)
    # 3%~6% 구간 중간(4.5%) → 70~88 의 중간 = 79
    assert score_from_conversion(0.045) == pytest.approx(79.0)


def test_ccv_trend_needs_four_broadcasts():
    pct, basis = ccv_trend([100.0, 100.0, 100.0])  # 3개 < 4
    assert pct is None and basis == "unknown"


def test_ccv_trend_rising_falling_flat():
    # 전반 [100,100] median 100, 후반 [200,200] median 200 → +100%
    pct, basis = ccv_trend([100.0, 100.0, 200.0, 200.0])
    assert pct == pytest.approx(1.0) and basis == "rising"
    pct, basis = ccv_trend([200.0, 200.0, 100.0, 100.0])
    assert pct == pytest.approx(-0.5) and basis == "falling"
    # 변화율 < flat band(10%) → flat
    pct, basis = ccv_trend([100.0, 100.0, 105.0, 105.0])
    assert pct == pytest.approx(0.05) and basis == "flat"


def test_compute_loyalty_scored():
    # 2개 방송, peak 1000/2000 (median 1500), 구독자 100k → 1.5% → 50점
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 800},
        {"video_id": "a", "sampled_at": "2026-06-01T10:30:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    out = compute_loyalty(samples, subscribers=100_000)
    assert out["broadcast_count"] == 2
    assert out["peak_ccv_median"] == 1500.0
    assert out["conversion_rate"] == pytest.approx(0.015)
    assert out["score"] == pytest.approx(50.0)
    assert out["basis"] == "scored"


def test_compute_loyalty_low_confidence_single_broadcast():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 3000},
    ]
    out = compute_loyalty(samples, subscribers=100_000)
    assert out["broadcast_count"] == 1
    assert out["basis"] == "low_confidence"
    assert out["score"] is not None


def test_compute_loyalty_insufficient_no_broadcast():
    out = compute_loyalty([], subscribers=100_000)
    assert out["basis"] == "insufficient"
    assert out["score"] is None
    assert out["broadcast_count"] == 0


def test_compute_loyalty_insufficient_bad_subscribers():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 3000},
    ]
    assert compute_loyalty(samples, subscribers=0)["basis"] == "insufficient"
    assert compute_loyalty(samples, subscribers=None)["basis"] == "insufficient"
