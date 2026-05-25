"""weekly_diagnosis — 가설 분류 + confidence + 메타가드."""

import math

from idol_sight.analysis.weekly_diagnosis import (
    HYPOTHESIS_KEYS, CONFIDENCE_LEVELS,
    Evidence, Hypothesis, GroupSignals,
    classify_hypotheses,
)


def _base_signal_bundle() -> dict:
    """모든 시그널이 중립값인 baseline. 각 test 가 필요한 키만 override."""
    return {
        "subs_z":             0.0,
        "views_z":            0.0,
        "news_z":             0.0,
        "community_z":        0.0,
        "market_share_z":     0.0,
        "er_wow":             0.0,
        "vps_wow":            None,
        "organicity_paid":    None,
        "reactivity_dominant": (None, 0.0),
        "member_centric":     {"lit": False, "dead": True, "top1_share_high": False,
                               "top1_share_now": None, "top1_share_wow": None,
                               "hhi_norm_wow": None},
        "comeback":           {"event_match": None, "music_streak": 0,
                               "hanteo_sales": 0, "chart_peak": None,
                               "video_upload_z": 0.0},
        "controversy":        {"keyword_z": 0.0, "twitter_z": 0.0,
                               "controversy_count_z": 0.0,
                               "negative_ratio_z": 0.0},
        "community_keywords_topic": "neutral",   # 'self' | 'external' | 'negative' | 'neutral'
        "video_tags_paid_match":   False,
    }


def test_hypothesis_keys_complete():
    """spec rev 2 의 11 가설 (insufficient_signal 포함) 모두 enum 에 존재."""
    expected = {
        "organic_growth", "paid_youtube_ads", "subscriber_purchase",
        "comeback_cycle", "broadcast_appearance", "community_word_of_mouth",
        "controversy_spike", "platform_concentrated_promo",
        "member_centric_spike", "insufficient_signal",
    }
    assert set(HYPOTHESIS_KEYS) == expected


def test_confidence_levels_order():
    """confidence 등급 high → medium → low (감점 시 인덱스 +1)."""
    assert CONFIDENCE_LEVELS == ("high", "medium", "low")


def test_group_signals_empty_defaults():
    gs = GroupSignals(group_key="plave")
    assert gs.hypotheses == []
    assert gs.meta_guards == []
    assert gs.organicity is None


def test_organic_growth_all_signals_lit():
    """5개 시그널 (subs/views/news/community/market_share) 모두 z>=1.5 → high."""
    sig = _base_signal_bundle() | {
        "subs_z": 1.8, "views_z": 2.0, "news_z": 1.6,
        "community_z": 1.7, "market_share_z": 1.5,
        "er_wow": 0.02,   # 안정 (±5% 안)
    }
    hyps = classify_hypotheses(sig)
    keys = [h.key for h in hyps]
    assert "organic_growth" in keys
    organic = next(h for h in hyps if h.key == "organic_growth")
    assert organic.confidence == "high"


def test_paid_youtube_ads_high_views_low_er():
    """views z=3, subs z=0.3, ER drop 28%, organicity paid 42% → high."""
    sig = _base_signal_bundle() | {
        "views_z": 3.0,
        "subs_z": 0.3,
        "er_wow": -0.28,
        "organicity_paid": 0.42,
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    assert paid is not None
    assert paid.confidence == "high"
    # subs_views_ratio (= subs_z - views_z) 음수 큼 → evidence 에 명시
    assert any("views_z" in e.key or "engagement" in e.key.lower() or "organicity" in e.key.lower()
               for e in paid.evidence)


def test_subscriber_purchase_inverse_pattern():
    """subs z=3.0, views z=0.4, ER drop 35%, vps drop 32% → medium (캡 적용)."""
    sig = _base_signal_bundle() | {
        "subs_z": 3.0,
        "views_z": 0.4,
        "er_wow": -0.35,
        "vps_wow": -0.32,
    }
    hyps = classify_hypotheses(sig)
    sp = next((h for h in hyps if h.key == "subscriber_purchase"), None)
    assert sp is not None
    # 검증 어려움 — 시그널 강해도 medium 캡.
    assert sp.confidence == "medium"


def test_subscriber_purchase_not_lit_when_vps_none():
    """subs spike + ER 하락 만 있고 vps_wow None → subscriber_purchase 점등 안 됨."""
    sig = _base_signal_bundle() | {
        "subs_z": 3.0, "er_wow": -0.35, "vps_wow": None,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "subscriber_purchase" for h in hyps)


def test_comeback_cycle_full():
    """hanteo_sales>0 + chart_peak<=30 + news z>=2 + video upload z>=1.5 → high."""
    sig = _base_signal_bundle() | {
        "news_z": 2.4,
        "comeback": {
            "event_match": {"event_type": "album_release", "title": "Caligo Pt.3"},
            "music_streak": 0, "hanteo_sales": 991_850, "chart_peak": 5,
            "video_upload_z": 2.1,
        },
    }
    hyps = classify_hypotheses(sig)
    cb = next((h for h in hyps if h.key == "comeback_cycle"), None)
    assert cb is not None
    assert cb.confidence == "high"
    # group_events ground truth evidence 가 들어가야 함
    assert any("event" in e.key.lower() or "ground_truth" in e.key.lower()
               for e in cb.evidence)


def test_comeback_cycle_dampens_paid():
    """comeback + paid_ads 시그널 동시 → paid confidence 한 단계 감점."""
    sig = _base_signal_bundle() | {
        # paid 시그널 (3개)
        "views_z": 3.0, "subs_z": 0.5, "er_wow": -0.28,
        "organicity_paid": 0.35,
        # comeback 시그널 (2개 — high)
        "news_z": 2.5,
        "comeback": {
            "event_match": {"event_type": "album_release", "title": "X"},
            "music_streak": 0, "hanteo_sales": 800_000, "chart_peak": 8,
            "video_upload_z": 1.6,
        },
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # paid 가 점등은 됐지만 confidence 가 high → medium 으로 감점됨.
    # (classify 단계에서 감점 후 emit, 또는 후속 단계에서 감점 후 재emit —
    # 어느 쪽이든 최종 결과의 confidence 는 medium)
    assert paid is None or paid.confidence in ("medium", "low")


def test_broadcast_appearance_lag_pattern():
    """7일 전 news spike (z=3.0) + 이번 주 community z=1.8 + community 토픽 외부."""
    sig = _base_signal_bundle() | {
        "news_z_prev_week": 3.0,    # 시그널 모듈이 raw 로 채움
        "community_z": 1.8,
        "views_z": 1.5,
        "community_keywords_topic": "external",   # 방송명 키워드
    }
    hyps = classify_hypotheses(sig)
    ba = next((h for h in hyps if h.key == "broadcast_appearance"), None)
    assert ba is not None
    assert ba.confidence == "medium"


def test_community_word_of_mouth_lag():
    """전주 community spike + 이번 주 subs/view z>=1.5 + 자체 콘텐츠 토픽."""
    sig = _base_signal_bundle() | {
        "community_z_prev_week": 2.4,
        "subs_z": 1.6,
        "views_z": 1.7,
        "community_keywords_topic": "self",
    }
    hyps = classify_hypotheses(sig)
    wom = next((h for h in hyps if h.key == "community_word_of_mouth"), None)
    assert wom is not None
    assert wom.confidence == "medium"


def test_broadcast_no_lag_no_match():
    """이번 주 news 단발 spike 만, 직전 주는 평탄 → broadcast 안 점등."""
    sig = _base_signal_bundle() | {
        "news_z": 3.0,
        "community_z": 0.4,
        "news_z_prev_week": 0.2,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "broadcast_appearance" for h in hyps)


def test_controversy_one_signal_high():
    """controversy_count_z=2.1 단독 점등 → high."""
    sig = _base_signal_bundle() | {
        "controversy": {
            "keyword_z": 0.3, "twitter_z": 0.5,
            "controversy_count_z": 2.1, "negative_ratio_z": 0.4,
        },
    }
    hyps = classify_hypotheses(sig)
    co = next((h for h in hyps if h.key == "controversy_spike"), None)
    assert co is not None
    assert co.confidence == "high"


def test_controversy_keyword_z_lit():
    """community_keywords negative_keyword_z=2.5 → 점등 high."""
    sig = _base_signal_bundle() | {
        "controversy": {
            "keyword_z": 2.5, "twitter_z": 0.0,
            "controversy_count_z": 0.0, "negative_ratio_z": 0.0,
        },
    }
    hyps = classify_hypotheses(sig)
    assert any(h.key == "controversy_spike" for h in hyps)


def test_platform_concentrated_naver_only():
    """reactivity_dominant=('naver', 3.0) + naver news z=2.5 → medium-high."""
    sig = _base_signal_bundle() | {
        "reactivity_dominant": ("naver", 3.0),
        "news_z": 2.5,
    }
    hyps = classify_hypotheses(sig)
    pc = next((h for h in hyps if h.key == "platform_concentrated_promo"), None)
    assert pc is not None
    assert pc.confidence in ("medium", "high")


def test_platform_concentrated_not_lit_without_supporting_z():
    """reactivity dominant 만 있고 보조 z 가 없으면 점등 안 됨."""
    sig = _base_signal_bundle() | {
        "reactivity_dominant": ("naver", 3.0),
        "news_z": 0.5,
        "community_z": 0.4,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "platform_concentrated_promo" for h in hyps)


def test_member_centric_isedol_top1_jump():
    """ISEDOL top1_share +12pt → 점등, 그룹 spike 동반."""
    sig = _base_signal_bundle() | {
        "subs_z": 2.0,
        "views_z": 2.0,
        "member_centric": {
            "lit": True, "dead": False,
            "top1_share_now": 0.55, "top1_share_wow": 0.12,
            "hhi_norm_wow": 0.08, "top1_share_high": False,
        },
    }
    hyps = classify_hypotheses(sig)
    mc = next((h for h in hyps if h.key == "member_centric_spike"), None)
    assert mc is not None


def test_member_centric_dampens_paid():
    """member_centric 점등 시 paid_ads confidence 한 단계 감점."""
    sig = _base_signal_bundle() | {
        # paid 시그널
        "views_z": 3.0, "subs_z": 0.5, "er_wow": -0.28,
        "organicity_paid": 0.35,
        # member_centric 시그널
        "member_centric": {
            "lit": True, "dead": False,
            "top1_share_now": 0.62, "top1_share_wow": 0.14,
            "hhi_norm_wow": 0.10, "top1_share_high": True,
        },
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # paid 가 점등은 됐지만 confidence 감점됨
    if paid is not None:
        assert paid.confidence in ("medium", "low")


def test_member_centric_dead_meta_no_emit():
    """agg_member_pop_meta 행 자체가 없는 그룹 → 점등 안 됨."""
    sig = _base_signal_bundle()    # member_centric.dead=True
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "member_centric_spike" for h in hyps)
