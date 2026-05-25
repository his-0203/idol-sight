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
from idol_sight.analysis.weekly_diagnosis_signals import member_centric_signals
from idol_sight.analysis.weekly_diagnosis_signals import (
    group_event_within_window, music_show_consecutive_wins,
)
from idol_sight.analysis.weekly_diagnosis_signals import (
    negative_keyword_z, twitter_controversy_z, NEGATIVE_KEYWORDS,
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


def test_member_centric_top1_share_jump():
    """top1_share 가 0.45 → 0.58 (+13pt) → 점등."""
    now = {"top1_share": 0.58, "top3_share": 0.78, "hhi_norm": 0.40}
    prev = {"top1_share": 0.45, "top3_share": 0.75, "hhi_norm": 0.30}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is True
    assert sig["top1_share_now"] == 0.58
    assert math.isclose(sig["top1_share_wow"], 0.13)


def test_member_centric_hhi_jump_without_top1():
    """top1 변화는 작지만 hhi_norm +0.18 점프 → 점등."""
    now = {"top1_share": 0.40, "top3_share": 0.85, "hhi_norm": 0.50}
    prev = {"top1_share": 0.38, "top3_share": 0.70, "hhi_norm": 0.32}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is True
    assert math.isclose(sig["hhi_norm_wow"], 0.18)


def test_member_centric_no_change():
    now = {"top1_share": 0.40, "top3_share": 0.75, "hhi_norm": 0.30}
    prev = {"top1_share": 0.39, "top3_share": 0.74, "hhi_norm": 0.29}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is False


def test_member_centric_missing_meta_returns_dead():
    """agg_member_pop_meta 행 자체가 없는 그룹 (corporate single-channel) → dead."""
    sig = member_centric_signals({}, {})
    assert sig["lit"] is False
    assert sig["dead"] is True


def test_group_event_match_within_7d():
    """event_date 가 주간 윈도우 ±7d 안에 있으면 매칭."""
    events = [
        {"event_date": "2026-05-22", "event_type": "album_release", "title": "Caligo Pt.3"},
        {"event_date": "2026-01-10", "event_type": "debut", "title": "Debut Show"},
    ]
    match = group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    )
    assert match is not None
    assert match["title"] == "Caligo Pt.3"


def test_group_event_no_match():
    events = [
        {"event_date": "2024-01-10", "event_type": "debut", "title": "Debut"},
    ]
    assert group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    ) is None


def test_group_event_window_edge_7d_before():
    """주간 시작 7일 전 = 윈도우 안 (5/18 - 7 = 5/11)."""
    events = [{"event_date": "2026-05-11", "event_type": "comeback", "title": "Comeback"}]
    match = group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    )
    assert match is not None


def test_group_event_window_8d_before_excluded():
    events = [{"event_date": "2026-05-10", "event_type": "comeback", "title": "Old"}]
    assert group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    ) is None


def test_music_show_consecutive_wins_3():
    """동일 곡 (song_title) 3회 연속 1위 → 점등."""
    wins = [
        {"show": "M Countdown", "song_title": "Pump Up The Volume", "win_date": "2026-05-20"},
        {"show": "Music Bank",   "song_title": "Pump Up The Volume", "win_date": "2026-05-21"},
        {"show": "Inkigayo",     "song_title": "Pump Up The Volume", "win_date": "2026-05-22"},
    ]
    streak = music_show_consecutive_wins(wins)
    assert streak["song_title"] == "Pump Up The Volume"
    assert streak["consecutive"] == 3


def test_music_show_consecutive_wins_below_threshold():
    """2회 → 점등 안 됨 (threshold 3)."""
    wins = [
        {"show": "M Countdown", "song_title": "A", "win_date": "2026-05-20"},
        {"show": "Music Bank",   "song_title": "A", "win_date": "2026-05-21"},
    ]
    streak = music_show_consecutive_wins(wins)
    assert streak["consecutive"] == 0


def test_negative_keyword_z_lit():
    """이번 주 부정 키워드 카운트 50, 과거 평균 10/표편 8 → z=5.0."""
    now_keywords = [
        {"keyword": "논란", "count": 30},
        {"keyword": "사과", "count": 15},
        {"keyword": "의혹", "count": 5},
        {"keyword": "활동", "count": 100},  # 부정 키워드 아님 — 제외
    ]
    past_weekly_neg_totals = [12, 8, 10, 5, 15, 7, 13, 9, 11, 10]
    z = negative_keyword_z(now_keywords, past_weekly_neg_totals)
    assert z > 2.5


def test_negative_keyword_z_zero_signal():
    """이번 주 부정 키워드 전혀 없음 → z 음수 또는 0."""
    now_keywords = [{"keyword": "콘서트", "count": 100}]
    past_weekly_neg_totals = [10, 12, 8]
    z = negative_keyword_z(now_keywords, past_weekly_neg_totals)
    assert z < 0


def test_twitter_controversy_z():
    """twitter_posts type='controversy' 카운트 z-score."""
    cohort = [1, 2, 0, 1, 3, 2, 1]   # 평균 1.43, sd~1.0
    z = twitter_controversy_z(now_count=8, cohort_counts=cohort)
    assert z > 4.0


def test_negative_keywords_list_includes_canonical():
    """spec 의 부정 키워드 카탈로그가 모두 포함되어 있는지 sanity check."""
    for kw in ("논란", "사과", "의혹", "해명"):
        assert kw in NEGATIVE_KEYWORDS
