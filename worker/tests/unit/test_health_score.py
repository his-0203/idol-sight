from datetime import date, timedelta

from idol_sight.analysis.health_score import (
    WEIGHTS,
    compute_dynamic_refs,
    compute_health_score,
)


def _agg(**kw):
    base = {
        "yt_subscribers": 0, "yt_total_views": 0,
        "likes_total": 0, "comments_total": 0,
        "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
        "naver_total_news": 0, "controversy_count": 0,
        "hanteo_sales": 0, "negative_ratio": 0.0,
        "v90_count": 0, "v30_count": 0,
    }
    base.update(kw)
    return base


def test_pre_debut_returns_pre_grade_and_null_total():
    future = (date.today() + timedelta(days=30)).isoformat()
    score = compute_health_score("miiwan", _agg(), debut_date=future)
    assert score.grade == "PRE"
    assert score.total is None
    assert score.label.startswith("데뷔 전")


def test_no_debut_date_returns_pre():
    score = compute_health_score("bdawn", _agg(), debut_date=None)
    assert score.grade == "PRE"
    assert score.total is None


def test_zero_activity_returns_d_grade_with_total_zero():
    past = (date.today() - timedelta(days=365)).isoformat()
    score = compute_health_score("plave", _agg(), debut_date=past)
    assert score.grade == "D"
    assert score.total is not None
    assert score.total < 3.0


def test_high_activity_returns_s_grade():
    past = (date.today() - timedelta(days=1000)).isoformat()
    # PLAVE-tier inputs: million-seller hanteo (drives RitualVictory +
    # Mobilization), high engagement, full community + news coverage.
    agg = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        likes_total=8_000_000, comments_total=600_000,
        dc_total_posts=50_000, theqoo_posts=20_000, instiz_posts=35_000,
        naver_total_news=300, controversy_count=0,
        hanteo_sales=1_000_000,   # millennium seller
        v90_count=20, v30_count=5,
    )
    score = compute_health_score("plave", agg, debut_date=past)
    assert score.grade in ("S", "A")
    assert score.total is not None and score.total >= 7.0


def test_breakdown_components_sum_consistent_with_raw_total():
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(yt_subscribers=200_000, yt_total_views=20_000_000,
               likes_total=600_000, comments_total=40_000,
               dc_total_posts=10_000, naver_total_news=100, controversy_count=0)
    score = compute_health_score("isedol", agg, debut_date=past)
    bd = score.breakdown
    # Components are present and non-negative.
    assert all(bd.get(k, 0) >= 0 for k in ("subscribers", "views", "quality",
                                            "community", "news", "risk"))


def test_dynamic_refs_returns_p90_per_dimension():
    cohort = [
        {"yt_subscribers": 100, "yt_total_views": 1_000,
         "likes_total": 10, "comments_total": 1,
         "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 5},
        {"yt_subscribers": 200, "yt_total_views": 2_000,
         "likes_total": 20, "comments_total": 2,
         "dc_total_posts": 100, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 10},
        {"yt_subscribers": 1_000_000, "yt_total_views": 100_000_000,
         "likes_total": 4_000_000, "comments_total": 200_000,
         "dc_total_posts": 50_000, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 300},
    ]
    refs = compute_dynamic_refs(cohort)
    # Top-tier (last group) drives p90; mid- and low-tier are pulled up
    # only modestly since the percentile interpolates.
    assert refs["subscribers"] > 200 and refs["subscribers"] <= 1_000_000
    # Floors kick in for empty cohorts but not here.
    assert refs["views"] > 1_000_000


def test_dynamic_refs_falls_back_to_floor_for_empty_cohort():
    refs = compute_dynamic_refs([])
    # Empty list → all floors.
    assert refs["subscribers"] >= 50_000
    assert refs["views"] >= 1_000_000
    assert refs["quality"] >= 0.005


def test_engagement_rate_is_quality_signal_not_top10():
    """Same channel size, different engagement → different quality scores.

    Pre-V2 the quality score was tied to top10-average-views (= channel
    size proxy). V2 ties it to (likes + 5·comments)/views so that two
    channels with the same view count but different fan interaction get
    different scores. This test enforces that.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    # Same views, very different likes+comments.
    low_eng = _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
                   likes_total=100_000, comments_total=2_000)
    high_eng = _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
                    likes_total=4_000_000, comments_total=200_000)
    s_low = compute_health_score("low", low_eng, debut_date=past)
    s_high = compute_health_score("high", high_eng, debut_date=past)
    assert s_high.breakdown["quality"] > s_low.breakdown["quality"]


def test_weights_constant_is_exposed():
    """The /api/health/spec endpoint will need this."""
    assert sum(WEIGHTS.values()) == 100   # spec §7.1 normalizes against 100 + bonus


# ─── V2.5 4-factor Health Score ────────────────────────────────────────


def test_factors_present_for_post_debut_groups():
    past = (date.today() - timedelta(days=400)).isoformat()
    score = compute_health_score(
        "plave",
        _agg(yt_subscribers=500_000, yt_total_views=50_000_000,
             likes_total=2_000_000, comments_total=100_000,
             dc_total_posts=10_000, naver_total_news=100,
             hanteo_sales=500_000),
        debut_date=past,
    )
    assert score.factors
    # All four factors present and non-negative.
    for k in ("reach", "ritual", "mobilization", "intimacy"):
        assert k in score.factors
        assert score.factors[k] >= 0
    assert score.group_model == "corporate"


def test_segmentary_weights_intimacy_higher_than_corporate():
    """ISEDOL-style group should put more of its score weight on
    Intimacy (engagement / community / live) than a same-input
    PLAVE-style corporate group."""
    past = (date.today() - timedelta(days=1000)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,   # high engagement
        dc_total_posts=20_000, theqoo_posts=5_000,
        naver_total_news=80, hanteo_sales=0,             # no album drop
    )
    s_corp = compute_health_score("x", common, debut_date=past,
                                   group_model="corporate")
    s_seg  = compute_health_score("x", common, debut_date=past,
                                   group_model="segmentary")
    # Same engagement input → segmentary's intimacy weight (40) > corporate's (15).
    assert s_seg.factors["intimacy"] > s_corp.factors["intimacy"]
    # Same views → corporate's mobilization weight (30) > segmentary's (25).
    assert s_corp.factors["mobilization"] >= s_seg.factors["mobilization"]


def test_confederation_intimacy_dominant():
    """STELLIVE-style — Intimacy should be the largest contributing
    factor by weight (55 of 100)."""
    past = (date.today() - timedelta(days=600)).isoformat()
    score = compute_health_score(
        "stellive",
        _agg(yt_subscribers=600_000, yt_total_views=80_000_000,
             likes_total=4_000_000, comments_total=400_000,
             dc_total_posts=8_000, theqoo_posts=4_000,
             naver_total_news=50),
        debut_date=past, group_model="confederation",
    )
    factors = score.factors
    # Intimacy beats every other factor for confederation.
    assert factors["intimacy"] > factors["reach"]
    assert factors["intimacy"] > factors["ritual"]
    assert factors["intimacy"] > factors["mobilization"]


def test_unknown_group_model_falls_back_to_corporate():
    past = (date.today() - timedelta(days=100)).isoformat()
    score = compute_health_score(
        "x", _agg(yt_subscribers=100_000), debut_date=past,
        group_model="unknown_garbage",
    )
    assert score.group_model == "corporate"


def test_negative_sentiment_compresses_intimacy_factor():
    """High negative_ratio should pull the intimacy factor down even
    when raw engagement is high (fans can be loud and unhappy)."""
    past = (date.today() - timedelta(days=400)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=20_000, naver_total_news=80,
    )
    happy = compute_health_score("x", {**common, "negative_ratio": 0.05},
                                  debut_date=past, group_model="segmentary")
    angry = compute_health_score("x", {**common, "negative_ratio": 0.6},
                                  debut_date=past, group_model="segmentary")
    assert happy.factors["intimacy"] > angry.factors["intimacy"]


def test_controversy_compresses_all_four_factors():
    """A risk_factor < 1.0 multiplies every factor, not just one."""
    past = (date.today() - timedelta(days=400)).isoformat()
    common = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=20_000, naver_total_news=80,
    )
    clean = compute_health_score("x", common, debut_date=past,
                                  group_model="corporate")
    scandal = compute_health_score("x", {**common, "controversy_count": 5},
                                    debut_date=past, group_model="corporate")
    for k in ("reach", "ritual", "mobilization", "intimacy"):
        # Strictly less when risk fires (5 controversies → factor 0.5).
        assert scandal.factors[k] < clean.factors[k]


# ─── V2.16 산식 보정 ────────────────────────────────────────────────────


def test_ritual_does_not_redistribute_when_hanteo_absent():
    """V2.16 Fix 1 — corporate 그룹에 hanteo가 없으면 ritual 산식이
    news/music_show 단독으로 100% 재정규화되지 않아야 한다.

    이전 동작: hanteo 부재 시 _wmean이 dead 항목을 분모에서 빼서
    news weight 0.20 → 1.00로 redistribute → ritual factor input ≈ news_n.
    의도하지 않은 boost.

    새 동작: ritual factor는 redistribute=False로 호출. dead 항목의
    weight는 분모에 살아있어서 그 만큼 자연 감소.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    # hanteo 없음, music_show_wins 없음, news만 살아 있는 corporate 그룹
    agg = _agg(
        yt_subscribers=80_000, yt_total_views=8_000_000,
        likes_total=200_000, comments_total=10_000,
        naver_total_news=100,    # cohort REF에 비해 충분히 큼
        hanteo_sales=0,
    )
    # cohort에 hanteo가 한 그룹만 있어도 cohort-level live 통과 →
    # per-group은 여전히 dead. 호출 시 live_metrics에 hanteo 포함시킴
    # (cohort에서 살아있다고 가정).
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 200,
        "music_show_wins": 5,
    }
    score = compute_health_score(
        "myrakl", agg, debut_date=past, refs=refs,
        group_model="corporate",
        live_metrics={"subscribers", "views", "news", "quality",
                      "hanteo", "music_show_wins"},
    )
    # news_n = 100/200 = 0.5 → 이전 산식이면 ritual_factor_input = 0.5,
    # weight 30 곱 → 15점. 새 산식이면 weight 0.20만 살아 있고 분모는
    # 1.00이라 ritual_factor_input ≈ 0.5 × 0.20 = 0.10, weight 30 × 0.10
    # = 3점. 적어도 절반 이하로 떨어져야 한다.
    assert score.factors["ritual"] < 7.5, (
        f"ritual={score.factors['ritual']} — hanteo 부재 시 redistribute 차단 "
        f"실패. news 단독 100% boost 그대로."
    )


def test_dynamic_refs_includes_external_cohort_when_provided():
    """V2.16 Fix 2 — external_cohort 인자가 있으면 p75 계산에 함께 합쳐
    REF가 외부 K-POP 시장 기준으로 끌어올려진다.

    이전 동작: cohort 8그룹 안에서만 p75 → PLAVE = top → 다른 그룹들은
    PLAVE 대비 비교. 외부 시장(에스파/뉴진스/RIIZE) 보이지 않음.

    새 동작: external_cohort 리스트도 percentile 입력에 합침.
    """
    cohort = [
        {"yt_subscribers": 1_000_000, "yt_total_views": 100_000_000,
         "likes_total": 4_000_000, "comments_total": 200_000,
         "dc_total_posts": 50_000, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 300},
        {"yt_subscribers": 200_000, "yt_total_views": 20_000_000,
         "likes_total": 800_000, "comments_total": 30_000,
         "dc_total_posts": 10_000, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 80},
    ]
    # 외부 K-POP 톱티어
    external = [
        {"yt_subscribers": 15_000_000, "yt_total_views": 8_000_000_000,
         "likes_total": 0, "comments_total": 0,
         "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 5_000},
        {"yt_subscribers": 8_000_000, "yt_total_views": 3_000_000_000,
         "likes_total": 0, "comments_total": 0,
         "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 2_500},
    ]
    refs_solo = compute_dynamic_refs(cohort)
    refs_w_ext = compute_dynamic_refs(cohort, external_cohort=external)
    # 외부 시장 합산하면 subscribers/views REF가 의미 있게 커진다.
    assert refs_w_ext["subscribers"] > refs_solo["subscribers"]
    assert refs_w_ext["views"] > refs_solo["views"]
    assert refs_w_ext["news"] > refs_solo["news"]


def test_dynamic_refs_external_cohort_none_is_backward_compat():
    """external_cohort=None 또는 미전달 시 기존 동작 유지."""
    cohort = [
        {"yt_subscribers": 100, "yt_total_views": 1_000,
         "likes_total": 0, "comments_total": 0,
         "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 5},
        {"yt_subscribers": 200, "yt_total_views": 2_000,
         "likes_total": 0, "comments_total": 0,
         "dc_total_posts": 0, "theqoo_posts": 0, "instiz_posts": 0,
         "naver_total_news": 10},
    ]
    refs_a = compute_dynamic_refs(cohort)
    refs_b = compute_dynamic_refs(cohort, external_cohort=None)
    assert refs_a == refs_b


def test_music_show_wins_signal_lifts_ritual():
    """V2.16 Fix 3 — agg.music_show_wins (음방 1위 누적 횟수) 가
    ritual factor를 끌어올린다.

    동일 그룹 / 동일 입력에서 music_show_wins=5 vs 0 → ritual 차이.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=20_000, naver_total_news=80,
        hanteo_sales=300_000,   # 한터 살림 → ritual base 확보
    )
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 500,
        "music_show_wins": 5,
    }
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "music_show_wins"}
    no_show = compute_health_score(
        "x", base, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    with_show = compute_health_score(
        "x", {**base, "music_show_wins": 5},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert with_show.factors["ritual"] > no_show.factors["ritual"]


def test_cold_start_floor_removed_absolute_scoring():
    """V2.16 Fix 4 — cold-start floor 제거. 90일 미만 그룹도 절대값 그대로.

    이전 동작: debut < 90일 → linear floor (3.5 ~ 0). 0일차 그룹이
    raw_total ≈ 0이어도 total ≥ 3.5.

    새 동작: floor 적용 안 함. raw_total이 그대로 [0, 10]에 매핑.
    """
    debut_3d_ago = (date.today() - timedelta(days=3)).isoformat()
    # 거의 zero-activity 신생 그룹
    score = compute_health_score("bdawn", _agg(), debut_date=debut_3d_ago)
    assert score.total is not None
    # 이전엔 floor=3.4 이상이었음. 새 동작은 0에 가까워야 함.
    assert score.total < 1.0, (
        f"total={score.total} — cold-start floor가 여전히 적용 중."
    )
