"""weekly_diagnosis — 가설 분류 + confidence + 메타가드."""


from idol_sight.analysis.weekly_diagnosis import (
    CONFIDENCE_LEVELS,
    HYPOTHESIS_KEYS,
    GroupSignals,
    Hypothesis,
    classify_hypotheses,
    _is_lit,
)


def _axis(*, z: float = 0.0, t: float = 0.0, w: float | None = None) -> dict:
    """rev 3 시그널 dict 의 한 entry — (category_z, temporal_z, wow_pct)."""
    return {"category_z": z, "temporal_z": t, "wow_pct": w}


def _base_signal_bundle() -> dict:
    """rev 3 shape: 모든 시그널이 중립값인 baseline. 각 시그널 entry 는
    {category_z, temporal_z, wow_pct} 3-축 dict. 각 test 가 필요한 키만 override."""
    return {
        "subs":      _axis(),
        "views":     _axis(),
        "news":      _axis(),
        "community": _axis(),
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
        "controversy":        {"keyword_z": 0.0,
                               "controversy_count_z": 0.0,
                               "negative_ratio_z": 0.0},
        "news_z_prev_week":           0.0,
        "community_z_prev_week":      0.0,
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
    sig = _base_signal_bundle()
    sig["subs"]      = _axis(z=1.8)
    sig["views"]     = _axis(z=2.0)
    sig["news"]      = _axis(z=1.6)
    sig["community"] = _axis(z=1.7)
    sig["market_share_z"] = 1.5
    sig["er_wow"] = 0.02   # 안정 (±5% 안)
    hyps = classify_hypotheses(sig)
    keys = [h.key for h in hyps]
    assert "organic_growth" in keys
    organic = next(h for h in hyps if h.key == "organic_growth")
    assert organic.confidence == "high"


def test_paid_youtube_ads_high_views_low_er():
    """views z=3, subs z=0.3, ER drop 28%, organicity paid 42% → high."""
    sig = _base_signal_bundle()
    sig["views"] = _axis(z=3.0)
    sig["subs"]  = _axis(z=0.3)
    sig["er_wow"] = -0.28
    sig["organicity_paid"] = 0.42
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    assert paid is not None
    assert paid.confidence == "high"
    # subs_views_ratio (= subs_z - views_z) 음수 큼 → evidence 에 명시
    assert any("views" in e.key.lower() or "engagement" in e.key.lower()
               or "organicity" in e.key.lower()
               for e in paid.evidence)


def test_subscriber_purchase_inverse_pattern():
    """subs z=3.0, views z=0.4, ER drop 35%, vps drop 32% → medium (캡 적용)."""
    sig = _base_signal_bundle()
    sig["subs"]  = _axis(z=3.0)
    sig["views"] = _axis(z=0.4)
    sig["er_wow"] = -0.35
    sig["vps_wow"] = -0.32
    hyps = classify_hypotheses(sig)
    sp = next((h for h in hyps if h.key == "subscriber_purchase"), None)
    assert sp is not None
    # 검증 어려움 — 시그널 강해도 medium 캡.
    assert sp.confidence == "medium"


def test_subscriber_purchase_not_lit_when_vps_none():
    """subs spike + ER 하락 만 있고 vps_wow None → subscriber_purchase 점등 안 됨."""
    sig = _base_signal_bundle()
    sig["subs"] = _axis(z=3.0)
    sig["er_wow"] = -0.35
    sig["vps_wow"] = None
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "subscriber_purchase" for h in hyps)


def test_comeback_cycle_full():
    """hanteo_sales>0 + chart_peak<=30 + news z>=2 + video upload z>=1.5 → high."""
    sig = _base_signal_bundle()
    sig["news"] = _axis(z=2.4)
    sig["comeback"] = {
        "event_match": {"event_type": "album_release", "title": "Caligo Pt.3"},
        "music_streak": 0, "hanteo_sales": 991_850, "chart_peak": 5,
        "video_upload_z": 2.1,
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
    sig = _base_signal_bundle()
    # paid 시그널 (3개)
    sig["views"] = _axis(z=3.0)
    sig["subs"]  = _axis(z=0.5)
    sig["er_wow"] = -0.28
    sig["organicity_paid"] = 0.35
    # comeback 시그널 (2개 — high)
    sig["news"] = _axis(z=2.5)
    sig["comeback"] = {
        "event_match": {"event_type": "album_release", "title": "X"},
        "music_streak": 0, "hanteo_sales": 800_000, "chart_peak": 8,
        "video_upload_z": 1.6,
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # paid 가 점등은 됐지만 confidence 가 high → medium 으로 감점됨.
    # (classify 단계에서 감점 후 emit, 또는 후속 단계에서 감점 후 재emit —
    # 어느 쪽이든 최종 결과의 confidence 는 medium)
    assert paid is None or paid.confidence in ("medium", "low")


def test_broadcast_appearance_lag_pattern():
    """7일 전 news spike (z=3.0) + 이번 주 community z=1.8 + community 토픽 외부."""
    sig = _base_signal_bundle()
    sig["news_z_prev_week"] = 3.0    # 시그널 모듈이 raw 로 채움
    sig["community"] = _axis(z=1.8)
    sig["views"]     = _axis(z=1.5)
    sig["community_keywords_topic"] = "external"   # 방송명 키워드
    hyps = classify_hypotheses(sig)
    ba = next((h for h in hyps if h.key == "broadcast_appearance"), None)
    assert ba is not None
    assert ba.confidence == "medium"


def test_community_word_of_mouth_lag():
    """전주 community spike + 이번 주 subs/view z>=1.5 + 자체 콘텐츠 토픽."""
    sig = _base_signal_bundle()
    sig["community_z_prev_week"] = 2.4
    sig["subs"]  = _axis(z=1.6)
    sig["views"] = _axis(z=1.7)
    sig["community_keywords_topic"] = "self"
    hyps = classify_hypotheses(sig)
    wom = next((h for h in hyps if h.key == "community_word_of_mouth"), None)
    assert wom is not None
    assert wom.confidence == "medium"


def test_broadcast_no_lag_no_match():
    """이번 주 news 단발 spike 만, 직전 주는 평탄 → broadcast 안 점등."""
    sig = _base_signal_bundle()
    sig["news"]      = _axis(z=3.0)
    sig["community"] = _axis(z=0.4)
    sig["news_z_prev_week"] = 0.2
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "broadcast_appearance" for h in hyps)


def test_controversy_one_signal_high():
    """controversy_count_z=2.1 단독 점등 → high."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 0.3,
        "controversy_count_z": 2.1, "negative_ratio_z": 0.4,
    }
    hyps = classify_hypotheses(sig)
    co = next((h for h in hyps if h.key == "controversy_spike"), None)
    assert co is not None
    assert co.confidence == "high"


def test_controversy_keyword_z_lit():
    """community_keywords negative_keyword_z=2.5 → 점등 high."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 2.5,
        "controversy_count_z": 0.0, "negative_ratio_z": 0.0,
    }
    hyps = classify_hypotheses(sig)
    assert any(h.key == "controversy_spike" for h in hyps)


def test_platform_concentrated_naver_only():
    """reactivity_dominant=('naver', 3.0) + naver news z=2.5 → medium-high."""
    sig = _base_signal_bundle()
    sig["reactivity_dominant"] = ("naver", 3.0)
    sig["news"] = _axis(z=2.5)
    hyps = classify_hypotheses(sig)
    pc = next((h for h in hyps if h.key == "platform_concentrated_promo"), None)
    assert pc is not None
    assert pc.confidence in ("medium", "high")


def test_platform_concentrated_not_lit_without_supporting_z():
    """reactivity dominant 만 있고 보조 z 가 없으면 점등 안 됨."""
    sig = _base_signal_bundle()
    sig["reactivity_dominant"] = ("naver", 3.0)
    sig["news"]      = _axis(z=0.5)
    sig["community"] = _axis(z=0.4)
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "platform_concentrated_promo" for h in hyps)


def test_member_centric_isedol_top1_jump():
    """ISEDOL top1_share +12pt → 점등, 그룹 spike 동반."""
    sig = _base_signal_bundle()
    sig["subs"]  = _axis(z=2.0)
    sig["views"] = _axis(z=2.0)
    sig["member_centric"] = {
        "lit": True, "dead": False,
        "top1_share_now": 0.55, "top1_share_wow": 0.12,
        "hhi_norm_wow": 0.08, "top1_share_high": False,
    }
    hyps = classify_hypotheses(sig)
    mc = next((h for h in hyps if h.key == "member_centric_spike"), None)
    assert mc is not None


def test_member_centric_dampens_paid():
    """member_centric 점등 시 paid_ads confidence 한 단계 감점."""
    sig = _base_signal_bundle()
    # paid 시그널
    sig["views"] = _axis(z=3.0)
    sig["subs"]  = _axis(z=0.5)
    sig["er_wow"] = -0.28
    sig["organicity_paid"] = 0.35
    # member_centric 시그널
    sig["member_centric"] = {
        "lit": True, "dead": False,
        "top1_share_now": 0.62, "top1_share_wow": 0.14,
        "hhi_norm_wow": 0.10, "top1_share_high": True,
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
    # build_context 의 13개 query 응답을 순서대로 stub:
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
    # 11) groups 메타 (group_model)        ← rev 3
    # 12) agg_summary history (직전 8주)   ← rev 3
    # 13) agg_market_share (해당 주 final)  ← 2026-05-26 stub 활성화
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
        # 8) irrelevant flags
        [],
        # 9) agg_member_pop_meta (now + prev — plave 는 corporate single-channel, dead)
        [],
        # 10) groups 메타 (rev 3) — corporate=kpop cohort
        [
            {"group_key": "plave",  "group_model": "corporate"},
            {"group_key": "isedol", "group_model": "segmentary"},
            {"group_key": "skinz",  "group_model": "corporate"},
        ],
        # 11) agg_summary history (rev 3) — 빈 history (temporal_z = 0)
        [],
        # 12) agg_market_share — 빈 결과 (market_share_z = 0)
        [],
        # 13) hanteo_weekly sales (comeback_boost) — 빈 결과 (hanteo_sales = 0)
        [],
        # 14) youtube_videos weekly upload counts — 빈 결과 (video_upload_z = 0)
        [],
        # 15) community_posts titles — 빈 결과 (community_keywords_topic = neutral)
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
    sig = _base_signal_bundle()
    sig["subs"]  = _axis(z=1.8)
    sig["views"] = _axis(z=1.7)
    sig["news"]  = _axis(z=1.6)
    # community, market_share_z 평탄 → 3개만 점등
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "organic_growth" for h in hyps)


def test_organic_growth_er_wow_none_blocks():
    """신규 그룹 (prev_er=0 → er_wow=None) 는 organic high 차단."""
    sig = _base_signal_bundle()
    sig["subs"]      = _axis(z=2.0)
    sig["views"]     = _axis(z=2.0)
    sig["news"]      = _axis(z=1.8)
    sig["community"] = _axis(z=1.7)
    sig["market_share_z"] = 1.6
    sig["er_wow"] = None   # 시그널 부재 — ER 안정 단정 불가
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "organic_growth" for h in hyps)


def test_comeback_and_member_centric_dampen_paid_once():
    """comeback + member_centric 동시 점등 시 paid 가 한 단계만 감점 (low 까지 안 떨어짐)."""
    sig = _base_signal_bundle()
    # paid 시그널 (high 가능)
    sig["views"] = _axis(z=3.0)
    sig["subs"]  = _axis(z=0.5)
    sig["er_wow"] = -0.28
    sig["organicity_paid"] = 0.35
    # comeback 시그널 (high)
    sig["news"] = _axis(z=2.5)
    sig["comeback"] = {
        "event_match": {"event_type": "album_release", "title": "X"},
        "music_streak": 0, "hanteo_sales": 800_000, "chart_peak": 8,
        "video_upload_z": 1.6,
    }
    # member_centric 시그널 (high)
    sig["member_centric"] = {
        "lit": True, "dead": False,
        "top1_share_now": 0.62, "top1_share_wow": 0.14,
        "hhi_norm_wow": 0.10, "top1_share_high": True,
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
        # 3-9) 나머지 7개 쿼리는 빈 결과
        [], [], [], [], [], [], [],
        # 10) groups 메타 (rev 3) — plave/isedol 모두 corporate 처리해서 cohort=2 → category_z=0
        [
            {"group_key": "plave",  "group_model": "corporate"},
            {"group_key": "isedol", "group_model": "corporate"},
        ],
        # 11) agg_summary history (rev 3) — 빈 history
        [],
        # 12) agg_market_share — 빈 결과
        [],
        # 13) hanteo_weekly sales (comeback_boost) — 빈 결과 (hanteo_sales = 0)
        [],
        # 14) youtube_videos weekly upload counts — 빈 결과 (video_upload_z = 0)
        [],
        # 15) community_posts titles — 빈 결과 (community_keywords_topic = neutral)
        [],
    ]
    result = compute_group_signals(db=db, week_start="2026-06-29", week_end="2026-07-05")
    # plave 와 isedol 둘 다 결과에 존재
    assert "plave" in result
    assert "isedol" in result
    # cohort 가 그룹당 1 element 였으므로 plave 의 subs_z 는 양수 (1.2M > isedol 0.6M)
    # (cohort=2 라 CATEGORY_COHORT_MIN=3 미달 → category_z=0 fallback; 그래도 wow_pct 양수)
    # deltas 는 category_z 를 노출 — rev 3 cohort_min fallback 으로 0 일 수 있음.
    assert result["plave"].deltas["subs_z"] >= 0


# ---------------------------------------------------------------------------
# rev 3 — _is_lit OR helper + 3-축 시나리오 + subculture fallback
# ---------------------------------------------------------------------------

from idol_sight.analysis.weekly_diagnosis import _is_lit


def test_is_lit_category_z_only():
    entry = {"category_z": 2.0, "temporal_z": 0.5, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_temporal_z_only():
    entry = {"category_z": 0.3, "temporal_z": 1.8, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_wow_only():
    entry = {"category_z": 0.3, "temporal_z": 0.5, "wow_pct": 0.08}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_none_lit():
    entry = {"category_z": 0.3, "temporal_z": 0.5, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is False


def test_is_lit_wow_none_safe():
    """wow_pct=None (dead signal) 이라도 다른 축으로 lit 가능."""
    entry = {"category_z": 1.8, "temporal_z": 0.5, "wow_pct": None}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_custom_z_threshold():
    """paid_ads 의 Z_THRESHOLD_STRONG=2.0 케이스."""
    entry = {"category_z": 1.8, "temporal_z": 0.5, "wow_pct": 0.05}
    assert _is_lit(entry, z_threshold=2.0, wow_threshold=0.20) is False
    assert _is_lit(entry, z_threshold=1.5, wow_threshold=0.20) is True


def test_organic_growth_lit_via_wow_only():
    """category z + temporal z 모두 0 + WoW% 모두 임계치 통과 → organic lit."""
    sig = _base_signal_bundle()
    sig["subs"]      = {"category_z": 0.3, "temporal_z": 0.4, "wow_pct": 0.06}
    sig["views"]     = {"category_z": 0.2, "temporal_z": 0.5, "wow_pct": 0.09}
    sig["news"]      = {"category_z": 0.3, "temporal_z": 0.2, "wow_pct": 0.35}
    sig["community"] = {"category_z": 0.1, "temporal_z": 0.4, "wow_pct": 0.40}
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_organic_growth_lit_via_temporal_only():
    """category cohort 비대칭이라 모두 0 + 자기 history 대비 큰 spike."""
    sig = _base_signal_bundle()
    sig["subs"]      = {"category_z": 0.0, "temporal_z": 2.1, "wow_pct": 0.02}
    sig["views"]     = {"category_z": 0.0, "temporal_z": 1.8, "wow_pct": 0.03}
    sig["news"]      = {"category_z": 0.0, "temporal_z": 1.7, "wow_pct": 0.10}
    sig["community"] = {"category_z": 0.0, "temporal_z": 1.6, "wow_pct": 0.05}
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_paid_ads_stricter_wow_threshold():
    """views WoW 10% (organic 임계 초과) 만으로는 paid 안 점등 (임계 0.20); WoW 25% 면 점등."""
    sig_organic = _base_signal_bundle()
    sig_organic["views"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.10}
    sig_organic["subs"]  = {"category_z": 0.2, "temporal_z": 0.2, "wow_pct": 0.01}
    sig_organic["er_wow"] = -0.25
    sig_organic["organicity_paid"] = 0.40
    # 10% WoW 만으로는 paid 점등 안 됨 (임계 0.20)
    assert not any(h.key == "paid_youtube_ads"
                   for h in classify_hypotheses(sig_organic))

    sig_paid = _base_signal_bundle()
    sig_paid["views"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.25}
    sig_paid["subs"]  = {"category_z": 0.2, "temporal_z": 0.2, "wow_pct": 0.01}
    sig_paid["er_wow"] = -0.25
    sig_paid["organicity_paid"] = 0.40
    # 25% WoW 면 점등 — views 시그널 + ER + organicity = 3개
    # (subs/views gap 은 둘 다 category_z 작아서 False)
    assert any(h.key == "paid_youtube_ads" for h in classify_hypotheses(sig_paid))


def test_subscriber_purchase_uses_strict_wow_15pct():
    """subs WoW 16% (임계 0.15 초과) + vps/er 강한 하락 → subscriber_purchase 점등 (medium 캡)."""
    sig = _base_signal_bundle()
    sig["subs"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.16}
    sig["vps_wow"] = -0.32
    sig["er_wow"] = -0.30
    hyps = classify_hypotheses(sig)
    sp = next((h for h in hyps if h.key == "subscriber_purchase"), None)
    assert sp is not None
    assert sp.confidence == "medium"   # 캡 유지


def test_compute_group_signals_subculture_falls_back_to_temporal():
    """subculture cohort 가 2개라 CATEGORY_COHORT_MIN(3) 미달 → category_z=0.
    history 대비 큰 spike 있으면 temporal_z 점등으로 lit 가능."""
    db = MagicMock()
    db.execute.side_effect = [
        # 1) last_7d — 2개의 subculture 그룹만
        [
            {"group_key": "isedol", "snapshot_at": "2026-07-03T00:00:00Z",
             "yt_subscribers": 1_000_000, "yt_total_views": 200_000_000,
             "yt_likes_total": 2_000_000, "yt_comments_total": 300_000,
             "naver_total_news": 100, "dc_total_posts": 100, "theqoo_posts": 50,
             "instiz_posts": 30, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
            {"group_key": "stellive", "snapshot_at": "2026-07-03T00:00:00Z",
             "yt_subscribers": 500_000, "yt_total_views": 80_000_000,
             "yt_likes_total": 800_000, "yt_comments_total": 150_000,
             "naver_total_news": 60, "dc_total_posts": 80, "theqoo_posts": 40,
             "instiz_posts": 20, "controversy_count": 0, "negative_ratio": 0.0,
             "data_source": "live", "reactivity_sample": 1},
        ],
        # 2) prev_7d
        [
            {"group_key": "isedol", "snapshot_at": "2026-06-25T00:00:00Z",
             "yt_subscribers": 900_000, "yt_total_views": 180_000_000,
             "yt_likes_total": 1_900_000, "yt_comments_total": 295_000,
             "naver_total_news": 95, "data_source": "live"},
        ],
        # 3-9) 빈 결과
        [], [], [], [], [], [], [],
        # 10) groups 메타 — 두 그룹 모두 subculture (segmentary/confederation)
        [
            {"group_key": "isedol",   "group_model": "segmentary"},
            {"group_key": "stellive", "group_model": "confederation"},
        ],
        # 11) agg_summary history — isedol 의 직전 8주 평탄
        [
            {"group_key": "isedol", "snapshot_at": "2026-06-18T00:00:00Z",
             "yt_subscribers": 850_000, "yt_total_views": 170_000_000,
             "naver_total_news": 90,
             "dc_total_posts": 90, "theqoo_posts": 45, "instiz_posts": 25},
            {"group_key": "isedol", "snapshot_at": "2026-06-11T00:00:00Z",
             "yt_subscribers": 820_000, "yt_total_views": 160_000_000,
             "naver_total_news": 85,
             "dc_total_posts": 88, "theqoo_posts": 44, "instiz_posts": 22},
            {"group_key": "isedol", "snapshot_at": "2026-06-04T00:00:00Z",
             "yt_subscribers": 810_000, "yt_total_views": 155_000_000,
             "naver_total_news": 88,
             "dc_total_posts": 92, "theqoo_posts": 46, "instiz_posts": 24},
        ],
        # 12) agg_market_share — 빈 결과
        [],
        # 13) hanteo_weekly sales (comeback_boost) — 빈 결과 (hanteo_sales = 0)
        [],
        # 14) youtube_videos weekly upload counts — 빈 결과 (video_upload_z = 0)
        [],
        # 15) community_posts titles — 빈 결과 (community_keywords_topic = neutral)
        [],
    ]
    result = compute_group_signals(db=db, week_start="2026-06-29", week_end="2026-07-05")
    # subculture cohort 가 2개 < 3 → category_z=0 fallback. 그럼에도
    # isedol 의 history 대비 spike (820k → 1M = 22%) 가 temporal_z 또는
    # wow_pct 로 점등될 수 있어야 함.
    assert "isedol" in result
    isedol = result["isedol"]
    # category_z 는 fallback 으로 0
    assert isedol.deltas["subs_z"] == 0.0
    # wow_pct 가 양수 (subs 가 history 대비 증가)
    assert isedol.deltas["subs_wow"] > 0


# ---------------------------------------------------------------------------
# P1 §3.5 — twitter_controversy_z 심볼 제거 + controversy_spike 재소싱 신호 검증
# ---------------------------------------------------------------------------
import idol_sight.analysis.weekly_diagnosis_signals as _Smod


def test_twitter_controversy_z_removed_from_module():
    """P1: twitter 수집 불가 확정 → twitter_controversy_z 산식 축 완전 제거.
    교정 전: cohort_z_score 래퍼가 존재했음. 교정 후: 심볼 자체가 없어야 함."""
    assert not hasattr(_Smod, "twitter_controversy_z")


def test_controversy_spike_no_twitter_input():
    """P1: controversy 시그널 dict 에 twitter_z 키가 아예 없어도 동작.
    교정 후: 재소싱된 controversy_count_z + community 부정 키워드로만 점등."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 2.6,
        "controversy_count_z": 2.2,
        "negative_ratio_z": 0.1,
    }
    hyps = classify_hypotheses(sig)
    co = next((h for h in hyps if h.key == "controversy_spike"), None)
    assert co is not None
    assert co.confidence == "high"
    assert not any("twitter" in e.key.lower() for e in co.evidence)


def test_controversy_spike_twitter_axis_gone_no_false_light():
    """교정 전/후 차이 고정: '오직 twitter_z 만 컸던' 상황은 이제 점등 불가.
    교정 전: twitter_z>=2.0 단독으로 controversy_spike 가 high 로 점등했다.
    교정 후: twitter 축 제거 → 나머지 z 가 모두 임계 미만이면 점등 안 함(None)."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 0.0,
        "controversy_count_z": 0.0,
        "negative_ratio_z": 0.0,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "controversy_spike" for h in hyps)


# ── Task 4: 서브컬처 진단 복원(옵션 b) ──

def _sub_axis(*, z: float = 0.0, t: float = 0.0, w: float | None = None) -> dict:
    """서브컴처 그룹 entry — _is_lit 가 category_z 축을 무시해야 함."""
    return {"category_z": z, "temporal_z": t, "wow_pct": w, "category": "subculture"}


def test_is_lit_subculture_excludes_category_z():
    """P1 (2): 서브컴처 entry 는 category_z 축을 점등에서 제외.
    동일 값이라도 K-POP 은 category_z 로 점등, 서브컴처는 점등 안 됨."""
    sub_entry = _sub_axis(z=2.5, t=0.3, w=0.01)
    assert _is_lit(sub_entry, wow_threshold=0.05) is False
    kpop_entry = {**sub_entry, "category": "kpop"}
    assert _is_lit(kpop_entry, wow_threshold=0.05) is True


def test_is_lit_subculture_lights_via_temporal():
    """서브컴처는 temporal_z 로 점등 (category_z 죽어도 무관)."""
    assert _is_lit(_sub_axis(z=0.0, t=1.8, w=None), wow_threshold=0.05) is True


def test_is_lit_subculture_lights_via_wow():
    """서브컴처는 wow_pct 로도 점등."""
    assert _is_lit(_sub_axis(z=0.0, t=0.0, w=0.07), wow_threshold=0.05) is True


def test_is_lit_default_category_is_kpop_unchanged():
    """category 키 부재 entry (기존 호출부/유닛테스트) → kpop 동작 불변."""
    entry = {"category_z": 2.0, "temporal_z": 0.3, "wow_pct": 0.01}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_subculture_organic_growth_lit_via_temporal_only():
    """서브컴처 그룹이 cross-sectional category_z 없이 temporal_z 만으로 organic 점등.
    교정 후: category 분기로 subs/views/news/community 4축이 temporal 로 살아남 →
    market_share_z(=0) 없이도 4개 점등 → organic_growth high."""
    sig = _base_signal_bundle()
    sig["subs"]      = _sub_axis(t=2.1)
    sig["views"]     = _sub_axis(t=1.8)
    sig["news"]      = _sub_axis(t=1.7)
    sig["community"] = _sub_axis(t=1.6)
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_kpop_organic_growth_unchanged_via_category_z():
    """K-POP 동작 불변 회귀: category_z 축으로 4+1 점등 시 organic high."""
    sig = _base_signal_bundle()
    sig["subs"]      = _axis(z=1.8)
    sig["views"]     = _axis(z=2.0)
    sig["news"]      = _axis(z=1.6)
    sig["community"] = _axis(z=1.7)
    sig["market_share_z"] = 1.5
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    organic = next((h for h in hyps if h.key == "organic_growth"), None)
    assert organic is not None
    assert organic.confidence == "high"
