"""Causal Diagnosis 시그널 — 순수 함수 (DB 의존 없음).

각 함수는 raw row dict 를 받아 시그널 값 (float / bool / dict) 을 반환한다.
값의 의미는 함수마다 다르지만 공통 컨벤션:
  - z-score 함수는 ±∞ 부동을 막기 위해 std==0 시 0 반환.
  - WoW ratio 함수는 분모가 0 일 때 None 반환 (호출자가 dead-signal 처리).
  - bool 점등 함수는 (점등, 강도, 라벨) 3-tuple 반환.

이 모듈을 import 한 곳은 모두 weekly_diagnosis.py 의 orchestrator 한 곳뿐 —
다른 파일에서 import 금지 (인터페이스를 좁게 유지).
"""

from __future__ import annotations

import math
from statistics import mean, stdev
from typing import Any


def cohort_z_score(value: float, cohort: list[float]) -> float:
    """Return z-score of `value` against cohort.

    cohort 가 비었거나 표준편차 0 이면 0 반환 (변별 불가 = 중립).
    """
    if not cohort:
        return 0.0
    if len(cohort) < 2:
        return 0.0
    sd = stdev(cohort)
    if sd == 0:
        return 0.0
    return (value - mean(cohort)) / sd


def wow_ratio(now: float | None, prev: float | None) -> float | None:
    """Week-over-week ratio = (now - prev) / max(prev, 1).

    prev 가 None 또는 0 이면 None 반환 (분모 불가 — dead signal).
    """
    if now is None or prev is None:
        return None
    if prev == 0:
        return None
    return (now - prev) / prev


def metric_delta(now: dict[str, Any], prev: dict[str, Any], key: str) -> float:
    """`now[key] - prev[key]`. 양쪽 모두 NULL coerce 후 차이.

    절대값 차이만 — z-score 가 필요하면 cohort_z_score 별도 호출.
    """
    n = float(now.get(key) or 0)
    p = float(prev.get(key) or 0)
    return n - p


def engagement_rate_from_agg(agg: dict[str, Any]) -> float:
    """(likes + 5·comments) / views — health_score._engagement_rate 와 동일.

    health_score.py 의 _engagement_rate 와 의도적으로 같은 산식 (운영자가
    두 모듈을 비교했을 때 일관성). views=0 일 때는 0.0 반환.
    """
    likes = float(agg.get("yt_likes_total") or 0)
    comments = float(agg.get("yt_comments_total") or 0)
    views = float(agg.get("yt_total_views") or 0)
    if views <= 0:
        return 0.0
    return (likes + 5 * comments) / views


def engagement_rate_wow_drop(now: dict[str, Any], prev: dict[str, Any]) -> float:
    """ER 의 WoW 변화율. prev_er=0 이면 0 (변화 없음으로 처리).

    음수가 클수록 ER 하락 큼 → paid_ads / sub_purchase 가설의 핵심 시그널.
    """
    now_er = engagement_rate_from_agg(now)
    prev_er = engagement_rate_from_agg(prev)
    if prev_er == 0:
        return 0.0
    return (now_er - prev_er) / prev_er


def views_per_sub(agg: dict[str, Any]) -> float | None:
    """views / subscribers. subs<=0 이면 None (dead signal).

    이 비율이 급락하면 sub 만 늘고 view 는 안 따라온 케이스 →
    subscriber_purchase 가설.
    """
    subs = float(agg.get("yt_subscribers") or 0)
    if subs <= 0:
        return None
    views = float(agg.get("yt_total_views") or 0)
    return views / subs


def views_per_sub_wow_drop(now: dict[str, Any], prev: dict[str, Any]) -> float | None:
    """views/sub 의 WoW 변화율. 어느 쪽이라도 None 이면 None.

    -0.30 이면 30% 하락 → subscriber_purchase 가설 시그널.
    """
    now_vps = views_per_sub(now)
    prev_vps = views_per_sub(prev)
    if now_vps is None or prev_vps is None or prev_vps == 0:
        return None
    return (now_vps - prev_vps) / prev_vps


def organicity_paid_ratio(videos: list[dict[str, Any]]) -> float | None:
    """`debut_window_video_organicity` 행들 중 suspect+likely_paid 비중.

    `insufficient_data` 행은 분모에서 제외 (debut_window_organicity 의
    내부 규약 — score_mean 계산에서도 동일하게 제외함).

    None 반환:
      - 입력이 빈 리스트
      - 모든 행이 insufficient_data (denom = 0)

    이 비율 ≥ 0.30 이 paid_youtube_ads 가설의 강한 시그널.
    """
    if not videos:
        return None
    scored = [v for v in videos if v.get("verdict") != "insufficient_data"]
    if not scored:
        return None
    paid = sum(1 for v in scored if v.get("verdict") in ("suspect", "likely_paid"))
    return paid / len(scored)


# Platform concentration 임계치. dominant 플랫폼의 reactivity 가 이 이상이고
# 나머지 모두가 OTHER_MAX_THRESHOLD 미만일 때만 점등.
REACTIVITY_DOMINANCE_THRESHOLD = 2.5
REACTIVITY_OTHER_MAX_THRESHOLD = 1.3
# reactivity_sample 가 이 미만이면 시그널 자체 차단 (표본 부족).
REACTIVITY_MIN_SAMPLE = 3


def reactivity_dominant_platform(agg: dict[str, Any]) -> tuple[str | None, float]:
    """단일 플랫폼이 reactivity 를 압도하는지 판정.

    Returns:
      (platform_name, ratio) 점등 시.
      (None, 0.0)            점등 안 됨.

    점등 조건:
      - reactivity_sample >= 3 (표본 부족 차단)
      - max(reactivity_*) >= 2.5
      - 나머지 3개 reactivity_* 가 모두 < 1.3

    platform_concentrated_promo 가설의 핵심 시그널.
    """
    if int(agg.get("reactivity_sample") or 0) < REACTIVITY_MIN_SAMPLE:
        return None, 0.0
    platforms = {
        "dc":     float(agg.get("reactivity_dc")     or 1.0),
        "theqoo": float(agg.get("reactivity_theqoo") or 1.0),
        "instiz": float(agg.get("reactivity_instiz") or 1.0),
        "naver":  float(agg.get("reactivity_naver")  or 1.0),
    }
    dom_name, dom_val = max(platforms.items(), key=lambda kv: kv[1])
    if dom_val < REACTIVITY_DOMINANCE_THRESHOLD:
        return None, 0.0
    others_max = max(v for k, v in platforms.items() if k != dom_name)
    if others_max >= REACTIVITY_OTHER_MAX_THRESHOLD:
        return None, 0.0
    return dom_name, dom_val
