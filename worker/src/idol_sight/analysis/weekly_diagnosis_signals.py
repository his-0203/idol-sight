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
from datetime import date, timedelta
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


# member_centric_spike 가설의 점등 임계치.
TOP1_SHARE_WOW_THRESHOLD = 0.10        # +10pt 이상
HHI_NORM_WOW_THRESHOLD = 0.15          # +0.15 이상
TOP1_SHARE_ABS_HIGH = 0.60             # 절대치 이 이상이면 high boost


def member_centric_signals(
    now: dict[str, Any], prev: dict[str, Any],
) -> dict[str, Any]:
    """agg_member_pop_meta 의 top1/top3/hhi_norm WoW 변화.

    Returns:
      {
        "lit":             bool,   # 점등 여부
        "dead":            bool,   # raw meta 가 없는 경우 (corporate single-channel)
        "top1_share_now":  float | None,
        "top1_share_wow":  float | None,
        "hhi_norm_wow":    float | None,
        "top1_share_high": bool,   # >= 0.60 → confidence boost
      }
    """
    t1_now = now.get("top1_share")
    t1_prev = prev.get("top1_share")
    hhi_now = now.get("hhi_norm")
    hhi_prev = prev.get("hhi_norm")

    if t1_now is None and hhi_now is None:
        return {
            "lit": False, "dead": True,
            "top1_share_now": None, "top1_share_wow": None,
            "hhi_norm_wow": None, "top1_share_high": False,
        }

    t1_wow = (
        (float(t1_now) - float(t1_prev)) if (t1_now is not None and t1_prev is not None) else None
    )
    hhi_wow = (
        (float(hhi_now) - float(hhi_prev)) if (hhi_now is not None and hhi_prev is not None) else None
    )

    lit = (
        (t1_wow is not None and t1_wow >= TOP1_SHARE_WOW_THRESHOLD)
        or (hhi_wow is not None and hhi_wow >= HHI_NORM_WOW_THRESHOLD)
    )
    return {
        "lit": lit,
        "dead": False,
        "top1_share_now": float(t1_now) if t1_now is not None else None,
        "top1_share_wow": t1_wow,
        "hhi_norm_wow": hhi_wow,
        "top1_share_high": (t1_now is not None and float(t1_now) >= TOP1_SHARE_ABS_HIGH),
    }


GROUP_EVENT_WINDOW_DAYS = 7
MUSIC_SHOW_STREAK_THRESHOLD = 3


def group_event_within_window(
    events: list[dict[str, Any]],
    *, week_start: str, week_end: str,
) -> dict[str, Any] | None:
    """주간 윈도우 [week_start - 7d, week_end + 7d] 안에 떨어지는 첫 매칭 이벤트.

    comeback_cycle 가설의 ground truth. group_events 테이블의 album_release /
    comeback / show_win / first_release / mv_release 등 이벤트와 매칭되면
    confidence 부스트.
    """
    ws = date.fromisoformat(week_start) - timedelta(days=GROUP_EVENT_WINDOW_DAYS)
    we = date.fromisoformat(week_end) + timedelta(days=GROUP_EVENT_WINDOW_DAYS)
    for ev in events:
        ed_raw = ev.get("event_date")
        if not ed_raw:
            continue
        try:
            ed = date.fromisoformat(ed_raw[:10])
        except ValueError:
            continue
        if ws <= ed <= we:
            return ev
    return None


def music_show_consecutive_wins(wins: list[dict[str, Any]]) -> dict[str, Any]:
    """같은 song_title 의 연속 1위 횟수. 정렬은 win_date 오름차순 가정.

    threshold (3) 미만이면 consecutive=0 으로 반환 (점등 안 됨 의미).
    comeback_cycle momentum 증거.
    """
    if not wins:
        return {"song_title": None, "consecutive": 0}
    sorted_wins = sorted(wins, key=lambda w: w.get("win_date") or "")
    # song_title 별 카운트 (가장 긴 streak 찾기)
    best = {"song_title": None, "consecutive": 0}
    current_song = None
    current_count = 0
    for w in sorted_wins:
        song = w.get("song_title")
        if song == current_song:
            current_count += 1
        else:
            current_song = song
            current_count = 1
        if current_count > best["consecutive"]:
            best = {"song_title": current_song, "consecutive": current_count}
    if best["consecutive"] < MUSIC_SHOW_STREAK_THRESHOLD:
        return {"song_title": None, "consecutive": 0}
    return best


# controversy 가설의 community_keywords 부정 키워드 카탈로그.
# 이 리스트가 부족하면 false negative — 누락 의심 시 확장.
NEGATIVE_KEYWORDS: frozenset[str] = frozenset({
    "논란", "사과", "의혹", "해명", "거짓",
    "비난", "악플", "고소", "탈퇴 요구",
    "스캔들", "표절", "갈등",
})


def negative_keyword_z(
    now_keywords: list[dict[str, Any]],
    past_weekly_neg_totals: list[float],
) -> float:
    """이번 주 NEGATIVE_KEYWORDS 카운트 합을 과거 주간 합 분포에 z-score 화.

    `past_weekly_neg_totals` 는 이전 N주의 부정 키워드 주간 합 (호출자
    책임). 분포 부족 (< 2 표본) 이면 0 반환.
    """
    now_total = sum(
        int(kw.get("count") or 0)
        for kw in now_keywords
        if kw.get("keyword") in NEGATIVE_KEYWORDS
    )
    return cohort_z_score(value=now_total, cohort=past_weekly_neg_totals)


def twitter_controversy_z(now_count: int, cohort_counts: list[float]) -> float:
    """twitter_posts type='controversy' 의 주간 카운트 z-score.

    controversy_spike 가설의 직접 시그널 (community_keywords 와 OR 결합).
    """
    return cohort_z_score(value=float(now_count), cohort=cohort_counts)
