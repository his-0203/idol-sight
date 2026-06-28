import pytest

from idol_sight.analysis.loyalty import (
    build_fan_loyalty,
    ccv_trend,
    compute_loyalty,
    median,
    score_from_conversion,
    subscribers_at,
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


def test_ccv_trend_odd_broadcasts_split():
    # 5개: 전반 [100,100] median 100, 후반 [100,300,300] median 300 → +200% rising
    pct, basis = ccv_trend([100.0, 100.0, 100.0, 300.0, 300.0])
    assert pct == pytest.approx(2.0) and basis == "rising"


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


def test_subscribers_at_picks_snapshot_at_or_before():
    series = [
        ("2026-05-01T00:00:00Z", 50_000),
        ("2026-05-20T00:00:00Z", 80_000),
        ("2026-06-05T00:00:00Z", 100_000),
    ]
    assert subscribers_at(series, "2026-04-01T00:00:00Z") == 50_000   # 이전 → 최초
    assert subscribers_at(series, "2026-05-20T00:00:00Z") == 80_000   # 동일 시점 포함
    assert subscribers_at(series, "2026-05-25T00:00:00Z") == 80_000   # 최근 ≤
    assert subscribers_at(series, "2026-06-10T00:00:00Z") == 100_000  # 이후 → 최신
    assert subscribers_at([], "2026-06-10T00:00:00Z") is None         # 이력 없음


def test_compute_loyalty_time_matches_subscribers_per_broadcast():
    # 초기 방송(구독자 50k 시점)과 최근 방송(구독자 100k 시점). 시점 매칭 시
    # 각 2% → median 2%. 편향(최신 구독자만)이었다면 median peak/100k = 1.5%.
    samples = [
        {"video_id": "a", "sampled_at": "2026-05-02T10:00:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    series = [("2026-05-01T00:00:00Z", 50_000), ("2026-06-05T00:00:00Z", 100_000)]
    out = compute_loyalty(samples, subscribers=100_000,
                          subs_at=lambda at: subscribers_at(series, at))
    assert out["conversion_rate"] == pytest.approx(0.02)   # median([0.02, 0.02])
    assert out["peak_ccv_median"] == 1500.0                # 표시용 median peak 불변
    assert out["subscribers"] == 100_000                   # 표시용 최신 구독자


def test_compute_loyalty_naive_unchanged_without_subs_at():
    # subs_at 없으면 기존 동작 유지: median peak / 최신 구독자 (하위호환)
    samples = [
        {"video_id": "a", "sampled_at": "2026-05-02T10:00:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    out = compute_loyalty(samples, subscribers=100_000)
    assert out["conversion_rate"] == pytest.approx(0.015)  # 1500/100000


def test_compute_loyalty_subs_at_falls_back_to_latest_when_none():
    # subs_at 이 None 반환(해당 시점 이력 없음)하면 latest subscribers 로 폴백
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
    ]
    out = compute_loyalty(samples, subscribers=100_000, subs_at=lambda at: None)
    assert out["conversion_rate"] == pytest.approx(0.015)


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


class _FakeClient:
    """execute()는 SQL 키워드로 분기해 고정 행 반환."""
    def __init__(self, tracked, samples, subs):
        self._tracked = tracked      # [{"key":...}]
        self._samples = samples      # [{group_key, video_id, sampled_at, concurrent_viewers}]
        self._subs = subs            # [{group_key, yt_subscribers, snapshot_at}]

    def execute(self, sql, params=None):
        if "ccv_tracked" in sql:
            return self._tracked
        if "live_ccv_samples" in sql:
            return self._samples
        if "yt_subscribers" in sql:
            return self._subs
        return []


def test_build_fan_loyalty_produces_row_per_tracked_group():
    client = _FakeClient(
        tracked=[{"key": "miiwan"}, {"key": "plave"}],
        samples=[
            {"group_key": "miiwan", "video_id": "a",
             "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1500},
            {"group_key": "miiwan", "video_id": "b",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
        ],
        subs=[
            {"group_key": "miiwan", "yt_subscribers": 100_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    # CLEAR 1 + 그룹 2 = 3 statements
    assert len(res.statements) == 3
    assert res.statements[0][0].strip().upper().startswith("DELETE")
    # plave 는 샘플 없음 → insufficient row 도 적재 (8그룹 카드 일관성)
    params_by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    assert set(params_by_group) == {"miiwan", "plave"}


def test_build_fan_loyalty_picks_latest_nonnull_subscribers():
    client = _FakeClient(
        tracked=[{"key": "miiwan"}],
        samples=[{"group_key": "miiwan", "video_id": "a",
                  "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500}],
        subs=[
            {"group_key": "miiwan", "yt_subscribers": 50_000,
             "snapshot_at": "2026-06-01T00:00:00Z"},
            {"group_key": "miiwan", "yt_subscribers": 100_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    miiwan = res.statements[1][1]
    # INSERT 컬럼: group_key, conversion_rate, peak_ccv_median, broadcast_count,
    #   subscribers, score, basis, ccv_trend_pct, trend_basis, window_days, snapshot_at
    # A1: 방송(06-05)은 그 시점 구독자(06-01 의 50k, 06-07 100k 는 방송 이후)로
    #     매칭 → 1500/50000 = 0.03. 표시 subscribers 는 최신 non-null(100k).
    assert miiwan[1] == pytest.approx(0.03)    # conversion_rate (시점 매칭: 1500/50000)
    assert miiwan[4] == 100_000                 # subscribers (최신 non-null, 표시용)


def test_compute_loyalty_ceiling_addon_sum():
    # floor: peak median 1500 / 1,000,000 구독자 = 0.15% → score 20 (하한 클램프).
    # ceiling(0102 합산 모델): (median peak 1500 + 위버스 add-on 100,000) / 1,000,000.
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    out = compute_loyalty(samples, subscribers=1_000_000, ceiling_estimate=100_000)
    # floor 불변 (YouTube 실측)
    assert out["peak_ccv_median"] == 1500.0
    assert out["conversion_rate"] == pytest.approx(0.0015)
    assert out["score"] == pytest.approx(20.0)
    assert out["basis"] == "scored"
    # ceiling = 유튜브 median peak + 위버스 add-on 합산
    assert out["ccv_ceiling"] == 101_500
    assert out["conversion_rate_ceiling"] == pytest.approx(0.1015)
    assert out["score_ceiling"] == pytest.approx(score_from_conversion(0.1015), abs=0.01)
    assert out["score_ceiling"] > out["score"]


def test_compute_loyalty_no_ceiling_estimate_fields_none():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1500},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
    ]
    out = compute_loyalty(samples, subscribers=100_000)  # ceiling_estimate 미지정
    assert out["conversion_rate_ceiling"] is None
    assert out["score_ceiling"] is None
    assert out["ccv_ceiling"] is None
    assert out["score"] == pytest.approx(50.0)  # floor 불변


def test_compute_loyalty_ceiling_skipped_when_insufficient():
    # 방송 0개 → insufficient. ceiling_estimate 가 있어도 ceiling 산출 안 함
    # (실제 라이브 활동 없으면 순수 추정만으로 점수 부여 금지).
    out = compute_loyalty([], subscribers=1_000_000, ceiling_estimate=150_000)
    assert out["basis"] == "insufficient"
    assert out["ccv_ceiling"] is None
    assert out["score_ceiling"] is None
    assert out["conversion_rate_ceiling"] is None


def test_build_fan_loyalty_injects_ceiling_for_configured_group():
    client = _FakeClient(
        tracked=[{"key": "plave", "ccv_ceiling_estimate": 100_000},
                 {"key": "miiwan", "ccv_ceiling_estimate": None}],
        samples=[
            {"group_key": "plave", "video_id": "a",
             "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 2000},
            {"group_key": "plave", "video_id": "b",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
            {"group_key": "miiwan", "video_id": "c",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
        ],
        subs=[
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
            {"group_key": "miiwan", "yt_subscribers": 100_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    params_by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    # INSERT 컬럼 끝 3개: conversion_rate_ceiling, score_ceiling, ccv_ceiling
    plave = params_by_group["plave"]
    # 합산 모델(0102): ccv_ceiling = median peak 2000 + 위버스 add-on 100,000.
    assert plave[-1] == 102_000                       # ccv_ceiling
    assert plave[-3] == pytest.approx(0.102)          # conversion_rate_ceiling (102000/1,000,000)
    assert plave[-2] == pytest.approx(score_from_conversion(0.102), abs=0.01)  # score_ceiling
    miiwan = params_by_group["miiwan"]
    assert miiwan[-1] is None                        # 천장 미설정 → None
    assert miiwan[-2] is None
    assert miiwan[-3] is None
