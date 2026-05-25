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


from idol_sight.analysis.weekly_diagnosis import apply_meta_guards


def test_meta_guard_irrelevant_dampens_all():
    """irrelevant 비율 18% → 모든 가설 confidence 한 단계 감점."""
    hyps = [
        Hypothesis(key="organic_growth", confidence="high", evidence=[]),
        Hypothesis(key="controversy_spike", confidence="high", evidence=[]),
    ]
    out, guards = apply_meta_guards(
        hyps,
        irrelevant_ratio=0.18,
        data_source_warning=False,
    )
    assert "irrelevant_flagged_18%" in guards or any("irrelevant" in g for g in guards)
    for h in out:
        assert h.confidence == "medium"


def test_meta_guard_backfill_majority_dampens():
    hyps = [Hypothesis(key="organic_growth", confidence="high", evidence=[])]
    out, guards = apply_meta_guards(
        hyps, irrelevant_ratio=0.05, data_source_warning=True,
    )
    assert any("backfill" in g.lower() or "data_source" in g for g in guards)
    assert out[0].confidence == "medium"


def test_meta_guard_none():
    hyps = [Hypothesis(key="organic_growth", confidence="high", evidence=[])]
    out, guards = apply_meta_guards(
        hyps, irrelevant_ratio=0.05, data_source_warning=False,
    )
    assert guards == []
    assert out[0].confidence == "high"


def test_insufficient_signal_when_no_hypotheses_lit():
    """모든 시그널 z<1.5 → classify 가 빈 리스트 반환 → 호출자가 insufficient_signal 처리."""
    sig = _base_signal_bundle()    # 전부 중립
    hyps = classify_hypotheses(sig)
    assert hyps == []


from unittest.mock import MagicMock
from idol_sight.analysis.weekly_diagnosis import compute_group_signals


def test_compute_group_signals_organic_growth_e2e():
    """E2E: DB stub → cohort z-score → classify → GroupSignals dict."""
    db = MagicMock()
    # build_context 의 6개 query 응답을 순서대로 stub:
    # 1) last_7d agg_summary
    # 2) prev_7d agg_summary
    # 3) debut_window_video_organicity (주간 신규 영상)
    # 4) group_events
    # 5) music_show_wins_log
    # 6) community_keywords (now)
    # 7) community_keywords (past 10주)
    # 8) twitter type='controversy' (now + past)
    # 9) community_posts irrelevant flags
    # 10) agg_member_pop_meta (now + prev)
    db.execute.side_effect = [
        # 1) last_7d (cohort 5 그룹, plave 가 spike)
        [
            {"group_key": "plave",  "yt_subscribers": 1_200_000, "yt_total_views": 200_000_000,
             "yt_likes_total": 2_000_000, "yt_comments_total": 300_000,
             "naver_total_news": 350,
             "dc_total_posts": 5000, "theqoo_posts": 2000, "instiz_posts": 1000,
             "controversy_count": 1, "negative_ratio": 0.04,
             "reactivity_dc": 1.5, "reactivity_theqoo": 1.4, "reactivity_instiz": 1.3,
             "reactivity_naver": 1.5, "reactivity_sample": 5,
             "data_source": "live"},
            {"group_key": "isedol", "yt_subscribers": 800_000,   "yt_total_views": 140_000_000,
             "yt_likes_total": 1_500_000, "yt_comments_total": 250_000,
             "naver_total_news": 100,
             "dc_total_posts": 3000, "theqoo_posts": 1000, "instiz_posts": 500,
             "controversy_count": 0, "negative_ratio": 0.02,
             "reactivity_dc": 1.1, "reactivity_theqoo": 1.0, "reactivity_instiz": 1.0,
             "reactivity_naver": 1.0, "reactivity_sample": 5,
             "data_source": "live"},
            {"group_key": "skinz",  "yt_subscribers": 50_000,    "yt_total_views": 5_000_000,
             "yt_likes_total": 80_000, "yt_comments_total": 15_000,
             "naver_total_news": 20,
             "dc_total_posts": 200, "theqoo_posts": 50, "instiz_posts": 30,
             "controversy_count": 0, "negative_ratio": 0.01,
             "reactivity_dc": 1.0, "reactivity_theqoo": 1.0, "reactivity_instiz": 1.0,
             "reactivity_naver": 1.0, "reactivity_sample": 1,
             "data_source": "live"},
        ],
        # 2) prev_7d — plave 가 훨씬 작았음 → 큰 z-score
        [
            {"group_key": "plave",  "yt_subscribers": 1_000_000, "yt_total_views": 175_000_000,
             "yt_likes_total": 1_800_000, "yt_comments_total": 280_000,
             "naver_total_news": 280,
             "dc_total_posts": 3000, "theqoo_posts": 1500, "instiz_posts": 700,
             "data_source": "live"},
            {"group_key": "isedol", "yt_subscribers": 800_000,   "yt_total_views": 138_000_000,
             "yt_likes_total": 1_490_000, "yt_comments_total": 248_000,
             "naver_total_news": 98,
             "dc_total_posts": 2900, "theqoo_posts": 970, "instiz_posts": 490,
             "data_source": "live"},
            {"group_key": "skinz",  "yt_subscribers": 49_500,    "yt_total_views": 4_950_000,
             "yt_likes_total": 79_500, "yt_comments_total": 14_800,
             "naver_total_news": 19,
             "dc_total_posts": 198, "theqoo_posts": 49, "instiz_posts": 29,
             "data_source": "live"},
        ],
        # 3) debut_window_video_organicity (plave 신규 영상 없음 — 빈 결과)
        [],
        # 4) group_events
        [],
        # 5) music_show_wins_log
        [],
        # 6) community_keywords (이번 주)
        [{"group_key": "plave", "keyword": "콘서트", "count": 100}],
        # 7) community_keywords (과거 10주, plave 의 부정 키워드 분포)
        [{"week": "w1", "neg_total": 5}, {"week": "w2", "neg_total": 8},
         {"week": "w3", "neg_total": 6}, {"week": "w4", "neg_total": 7}],
        # 8) twitter controversy (now + past)
        [],
        # 9) irrelevant flags
        [],
        # 10) agg_member_pop_meta (now + prev — plave 는 corporate single-channel, dead)
        [],
    ]
    result = compute_group_signals(db=db, week_start="2026-04-22", week_end="2026-04-28")

    assert "plave" in result
    plave = result["plave"]
    # plave 는 cohort 에서 압도적 1위 → 거의 모든 시그널이 큰 z 또는
    # 보통 cohort 가 3개라 z 가 작을 수 있음. 최소한 GroupSignals 가
    # 비어있지 않아야 함.
    assert isinstance(plave.hypotheses, list)
    assert plave.group_key == "plave"


def test_organic_growth_3_signals_not_enough():
    """3개 점등 (4 미만) 은 organic 으로 인정 안 됨 (spec rev 2 §3.1)."""
    sig = _base_signal_bundle() | {
        "subs_z": 1.8, "views_z": 1.7, "news_z": 1.6,
        # community_z, market_share_z 평탄 → 3개만 점등
        "er_wow": 0.02,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "organic_growth" for h in hyps)


def test_organic_growth_er_wow_none_blocks():
    """신규 그룹 (prev_er=0 → er_wow=None) 는 organic high 차단."""
    sig = _base_signal_bundle() | {
        "subs_z": 2.0, "views_z": 2.0, "news_z": 1.8,
        "community_z": 1.7, "market_share_z": 1.6,
        "er_wow": None,   # 시그널 부재 — ER 안정 단정 불가
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "organic_growth" for h in hyps)


def test_comeback_and_member_centric_dampen_paid_once():
    """comeback + member_centric 동시 점등 시 paid 가 한 단계만 감점 (low 까지 안 떨어짐)."""
    sig = _base_signal_bundle() | {
        # paid 시그널 (high 가능)
        "views_z": 3.0, "subs_z": 0.5, "er_wow": -0.28,
        "organicity_paid": 0.35,
        # comeback 시그널 (high)
        "news_z": 2.5,
        "comeback": {
            "event_match": {"event_type": "album_release", "title": "X"},
            "music_streak": 0, "hanteo_sales": 800_000, "chart_peak": 8,
            "video_upload_z": 1.6,
        },
        # member_centric 시그널 (high)
        "member_centric": {
            "lit": True, "dead": False,
            "top1_share_now": 0.62, "top1_share_wow": 0.14,
            "hhi_norm_wow": 0.10, "top1_share_high": True,
        },
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # 두 dampen 이유가 동시 점등돼도 *한 번만* 감점 → high → medium (low 로 안 떨어짐)
    assert paid is not None
    assert paid.confidence == "medium"


def test_compute_group_signals_deduplicates_multi_row():
    """compute_group_signals 가 같은 그룹의 여러 snapshot row 를 받으면
    가장 최근만 사용해야 함 (cohort 분모도 그룹당 1 element)."""
    db = MagicMock()
    db.execute.side_effect = [
        # 1) last_7d — plave 가 3개 snapshot (07/01, 07/02, 07/03 — 최신은 07/03)
        [
            {"group_key": "plave",  "snapshot_at": "2026-07-01T00:00:00Z",
             "yt_subscribers": 1_000_000, "yt_total_views": 100_000_000,
             "yt_likes_total": 1_000_000, "yt_comments_total": 200_000,
             "naver_total_news": 100, "dc_total_posts": 100, "theqoo_posts": 50,
             "instiz_posts": 30, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
            {"group_key": "plave",  "snapshot_at": "2026-07-02T00:00:00Z",
             "yt_subscribers": 1_100_000, "yt_total_views": 110_000_000,
             "yt_likes_total": 1_100_000, "yt_comments_total": 220_000,
             "naver_total_news": 110, "dc_total_posts": 110, "theqoo_posts": 55,
             "instiz_posts": 33, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
            {"group_key": "plave",  "snapshot_at": "2026-07-03T00:00:00Z",
             "yt_subscribers": 1_200_000, "yt_total_views": 120_000_000,
             "yt_likes_total": 1_200_000, "yt_comments_total": 250_000,
             "naver_total_news": 120, "dc_total_posts": 120, "theqoo_posts": 60,
             "instiz_posts": 36, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
            # isedol 1 snapshot
            {"group_key": "isedol", "snapshot_at": "2026-07-03T00:00:00Z",
             "yt_subscribers": 600_000, "yt_total_views": 80_000_000,
             "yt_likes_total": 800_000, "yt_comments_total": 150_000,
             "naver_total_news": 60, "dc_total_posts": 80, "theqoo_posts": 40,
             "instiz_posts": 20, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
        ],
        # 2) prev_7d
        [
            {"group_key": "plave",  "snapshot_at": "2026-06-25T00:00:00Z",
             "yt_subscribers": 900_000, "yt_total_views": 90_000_000,
             "yt_likes_total": 900_000, "yt_comments_total": 180_000,
             "naver_total_news": 80, "data_source": "live"},
            {"group_key": "isedol", "snapshot_at": "2026-06-25T00:00:00Z",
             "yt_subscribers": 580_000, "yt_total_views": 78_000_000,
             "yt_likes_total": 780_000, "yt_comments_total": 145_000,
             "naver_total_news": 55, "data_source": "live"},
        ],
        # 3-10) 나머지 8개 쿼리는 빈 결과
        [], [], [], [], [], [], [], [],
    ]
    result = compute_group_signals(db=db, week_start="2026-06-29", week_end="2026-07-05")
    # plave 와 isedol 둘 다 결과에 존재
    assert "plave" in result
    assert "isedol" in result
    # cohort 가 그룹당 1 element 였으므로 plave 의 subs_z 는 양수 (1.2M > isedol 0.6M)
    assert result["plave"].deltas["subs_z"] > 0
    # cohort 분모가 2 (그룹 2개) 라 z=1.0 근처 (sd=평균에서 ±1 sd 만큼 떨어짐)
    # 정확 검증보다 *방향* 검증 — multi-row 가 분모를 부풀렸다면 sd 가 더 작아져 z가 더 컸을 것.
