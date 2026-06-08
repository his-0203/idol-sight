"""Fan loyalty scoring (V2.46) from live CCV concurrency.

CCV 절대값은 규모 신호. 충성도 = median peak CCV / subscribers (전환율) —
규모와 직교. 고정 벤치마크 임계값(first-pass), 라이브 데이터로 보정 예정.
Heuristic, not ground-truth.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "median",
    "score_from_conversion",
    "ccv_trend",
    "compute_loyalty",
    "build_fan_loyalty",
    "WINDOW_DAYS",
    "LOYALTY_ANCHORS",
    "TREND_FLAT_BAND",
    "MIN_BROADCASTS_FOR_TREND",
]

WINDOW_DAYS = 56

# (전환율, 점수) 앵커. 구간 선형보간 + 양끝 클램프. FIRST-PASS — 라이브 CCV
# 분포 축적 후 실측으로 보정한다. 버추얼 아이돌 라이브 전환율 가설:
# <0.5% 매우낮음 / 1.5% 보통 진입 / 6%+ 매우높음.
LOYALTY_ANCHORS: list[tuple[float, float]] = [
    (0.005, 20.0),
    (0.015, 50.0),
    (0.03, 70.0),
    (0.06, 88.0),
    (0.12, 100.0),
]

TREND_FLAT_BAND = 0.10          # |증감율| < 10% → flat
MIN_BROADCASTS_FOR_TREND = 4    # 전·후 각 2개 미만이면 추세 보류


def median(values: list[float]) -> float:
    """Median of a non-empty list. Even length → mean of two middles."""
    if not values:
        raise ValueError("median requires a non-empty list")
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def score_from_conversion(rate: float) -> float:
    """전환율(0~1)을 LOYALTY_ANCHORS 구간 선형보간으로 0~100 점수화."""
    if rate <= LOYALTY_ANCHORS[0][0]:
        return LOYALTY_ANCHORS[0][1]
    if rate >= LOYALTY_ANCHORS[-1][0]:
        return LOYALTY_ANCHORS[-1][1]
    for (r0, s0), (r1, s1) in zip(LOYALTY_ANCHORS, LOYALTY_ANCHORS[1:]):
        if r0 <= rate <= r1:
            frac = (rate - r0) / (r1 - r0)
            return s0 + frac * (s1 - s0)
    return LOYALTY_ANCHORS[-1][1]  # unreachable, 방어


def ccv_trend(peaks_chrono: list[float]) -> tuple[float | None, str]:
    """방송별 peak CCV(시간순)를 전·후반 median 비교로 증감율 산출.

    방송 4개 미만이면 unknown(추세 보류). |증감율| < flat band → flat.
    """
    n = len(peaks_chrono)
    if n < MIN_BROADCASTS_FOR_TREND:
        return None, "unknown"
    half = n // 2  # 홀수 방송 시 전반 작고 후반 큼 (최근 방송에 더 무게)
    first = median(peaks_chrono[:half])
    second = median(peaks_chrono[half:])
    if first <= 0:
        return None, "unknown"
    pct = (second - first) / first
    if abs(pct) < TREND_FLAT_BAND:
        return pct, "flat"
    return pct, ("rising" if pct > 0 else "falling")


def compute_loyalty(
    samples: list[dict[str, Any]], subscribers: int | None,
) -> dict[str, Any]:
    """그룹의 윈도우-내 CCV 샘플 + 구독자 → 충성도 row 필드 dict.

    samples: [{video_id, sampled_at, concurrent_viewers}, ...] (윈도우 사전필터됨).
    distinct video_id = distinct 방송. 방송별 peak = MAX(ccv).
    """
    base = {
        "conversion_rate": None, "peak_ccv_median": None,
        "broadcast_count": 0, "subscribers": subscribers,
        "score": None, "basis": "insufficient",
        "ccv_trend_pct": None, "trend_basis": "unknown",
    }
    # 방송별 peak + 방송 시점(최초 샘플) 집계.
    by_video: dict[str, dict[str, Any]] = {}
    for s in samples:
        vid = s["video_id"]
        ccv = float(s["concurrent_viewers"] or 0)
        at = s["sampled_at"]
        cur = by_video.get(vid)
        if cur is None:
            by_video[vid] = {"peak": ccv, "first_at": at}
        else:
            cur["peak"] = max(cur["peak"], ccv)
            cur["first_at"] = min(cur["first_at"], at)

    bc = len(by_video)
    base["broadcast_count"] = bc
    if bc == 0:
        return base
    if not subscribers or subscribers <= 0:
        return base  # insufficient — 분모 sanity (V2.43.3 동결/이상치 방어)

    peaks = [v["peak"] for v in by_video.values()]
    peak_med = median(peaks)
    rate = peak_med / subscribers
    base["peak_ccv_median"] = peak_med
    base["conversion_rate"] = rate
    base["score"] = round(score_from_conversion(rate), 2)
    base["basis"] = "low_confidence" if bc == 1 else "scored"

    # 증감율 — 방송 시점순 peak 나열 (표시용, score 미반영).
    chrono = [v["peak"] for v in sorted(by_video.values(), key=lambda x: x["first_at"])]
    pct, tbasis = ccv_trend(chrono)
    base["ccv_trend_pct"] = (round(pct, 4) if pct is not None else None)
    base["trend_basis"] = tbasis
    return base
