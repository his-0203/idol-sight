"""Fan loyalty scoring (V2.46) from live CCV concurrency.

CCV 절대값은 규모 신호. 충성도 = median peak CCV / subscribers (전환율) —
규모와 직교. 고정 벤치마크 임계값(first-pass), 라이브 데이터로 보정 예정.
Heuristic, not ground-truth.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "median",
    "score_from_conversion",
    "ccv_trend",
    "subscribers_at",
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


def subscribers_at(series: list[tuple[str, int]], at: str) -> int | None:
    """방송 시점(at) 기준 가장 최근(snapshot_at ≤ at) 구독자 스냅샷 값.

    at 이 모든 스냅샷보다 이르면 최초(가장 이른) 스냅샷, series 가 비면 None.
    snapshot_at 은 ISO8601 문자열이라 사전식 비교가 시간순과 일치(정렬 무관).
    """
    if not series:
        return None
    chosen: int | None = None
    chosen_at: str | None = None
    for snap_at, subs in series:
        if snap_at <= at and (chosen_at is None or snap_at > chosen_at):
            chosen_at, chosen = snap_at, subs
    if chosen is None:  # at 이 모든 스냅샷보다 이름 → 최초 스냅샷
        return min(series, key=lambda x: x[0])[1]
    return chosen


def compute_loyalty(
    samples: list[dict[str, Any]], subscribers: int | None,
    subs_at: Callable[[str], int | None] | None = None,
) -> dict[str, Any]:
    """그룹의 윈도우-내 CCV 샘플 + 구독자 → 충성도 row 필드 dict.

    samples: [{video_id, sampled_at, concurrent_viewers}, ...] (윈도우 사전필터됨).
    distinct video_id = distinct 방송. 방송별 peak = MAX(ccv).

    subs_at(broadcast_time) → 그 방송 시점의 구독자 (A1, 시점 매칭). 주면 방송별
    전환율을 각자의 시점 구독자로 산출해 급성장 채널(데뷔기 MiiWAN)의 분모 과대
    편향을 제거한다. None 이면 모든 방송이 `subscribers`(최신)를 써 결과가
    median(peaks)/subscribers 와 동일(하위호환).
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
    # 방송별 전환율 — 각 방송을 그 시점 구독자로 나눠 시점 편향 제거(A1). subs_at
    # 없거나 그 시점 구독자가 결측/0 이면 최신 subscribers 로 폴백. 모든 방송이
    # 동일 분모면 median(convs) == median(peaks)/subscribers (하위호환).
    convs: list[float] = []
    for v in by_video.values():
        sb = subs_at(v["first_at"]) if subs_at is not None else None
        if not sb or sb <= 0:
            sb = subscribers
        if sb and sb > 0:
            convs.append(v["peak"] / sb)
    if not convs:
        return base  # 모든 방송에서 분모 결측 — insufficient
    rate = median(convs)
    base["peak_ccv_median"] = median(peaks)  # 표시용 (규모 신호, 분모 무관)
    base["conversion_rate"] = rate
    base["score"] = round(score_from_conversion(rate), 2)
    base["basis"] = "low_confidence" if bc == 1 else "scored"

    # 증감율 — 방송 시점순 peak 나열 (표시용, score 미반영).
    chrono = [v["peak"] for v in sorted(by_video.values(), key=lambda x: x["first_at"])]
    pct, tbasis = ccv_trend(chrono)
    base["ccv_trend_pct"] = (round(pct, 4) if pct is not None else None)
    base["trend_basis"] = tbasis
    return base


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_CLEAR_SQL = "DELETE FROM agg_fan_loyalty"

_TRACKED_SQL = "SELECT key FROM groups WHERE ccv_tracked=1"

_SUBS_SQL = (
    "SELECT group_key, yt_subscribers, snapshot_at FROM agg_summary "
    "WHERE yt_subscribers IS NOT NULL"
)

_INSERT_SQL = """
INSERT INTO agg_fan_loyalty
  (group_key, conversion_rate, peak_ccv_median, broadcast_count,
   subscribers, score, basis, ccv_trend_pct, trend_basis,
   window_days, snapshot_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def build_fan_loyalty(client: _Executor) -> CollectionResult:
    """ccv_tracked 그룹별 충성도 스냅샷. full DELETE+rebuild.

    insufficient(라이브 없음/구독자 결측) 그룹도 row를 남겨 8그룹 카드가
    '데이터 축적 중'을 표시할 수 있게 한다.
    """
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff = (datetime.now(UTC) - timedelta(days=WINDOW_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    tracked = [r["key"] for r in client.execute(_TRACKED_SQL)]

    sample_rows = client.execute(
        "SELECT group_key, video_id, sampled_at, concurrent_viewers "
        "FROM live_ccv_samples "
        "WHERE sampled_at >= ? AND concurrent_viewers IS NOT NULL",
        [cutoff],
    )
    samples_by_group: dict[str, list[dict]] = {}
    for r in sample_rows:
        samples_by_group.setdefault(r["group_key"], []).append(r)

    # 그룹별 구독자 시계열 (snapshot_at 오름차순) — 방송별 시점 매칭(A1)용.
    # 최신값은 series[-1] (표시/폴백 분모), 과거 방송은 그 시점 값으로 매칭.
    subs_series_by_group: dict[str, list[tuple[str, int]]] = {}
    for r in client.execute(_SUBS_SQL):
        subs_series_by_group.setdefault(r["group_key"], []).append(
            (r["snapshot_at"], r["yt_subscribers"])
        )
    for series in subs_series_by_group.values():
        series.sort(key=lambda x: x[0])

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [])]
    for gk in tracked:
        series = subs_series_by_group.get(gk, [])
        latest = series[-1][1] if series else None
        out = compute_loyalty(
            samples_by_group.get(gk, []), latest,
            subs_at=(lambda at, s=series: subscribers_at(s, at)) if series else None,
        )
        statements.append((_INSERT_SQL, [
            gk, out["conversion_rate"], out["peak_ccv_median"],
            out["broadcast_count"], out["subscribers"], out["score"],
            out["basis"], out["ccv_trend_pct"], out["trend_basis"],
            WINDOW_DAYS, now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
