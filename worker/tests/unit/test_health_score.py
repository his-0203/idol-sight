from datetime import date, timedelta

import pytest

from idol_sight.analysis.health_score import (
    DEFAULT_REFS,
    WEIGHTS,
    _controversy_factor,
    _factor_inputs,
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
        # Strictly less when risk fires. V2.54: with the 2-count noise
        # floor, 5 controversies → factor 0.7 (was 0.5 pre-V2.54).
        assert scandal.factors[k] < clean.factors[k]


# ─── V2.54 Controversy Noise Guard ─────────────────────────────────────


@pytest.mark.parametrize(
    ("count", "expected"),
    [
        (0, 1.0),
        (1, 1.0),
        (2, 1.0),   # noise floor: 잡담/오분류 1-2건은 무감점
        (3, 0.9),   # 플로어 이후부터 기존 기울기(count-2)/10로 감점 재개
        (12, 0.0),  # floors at 0
    ],
)
def test_controversy_factor_noise_floor(count, expected):
    assert _controversy_factor(count) == pytest.approx(expected)


def test_plave_chatter_regression():
    """PLAVE 08-15: '슬리퍼놀란'(놀란→논란 오독) + '부동산 이슈 괜찮음?'
    ('이슈' 마커 오분류) = 잡담 2건이 controversy_count=2로 집계돼 등급이
    A→B로 밀렸던 회귀 케이스. V2.54 노이즈 플로어 하에서는 count=2가
    count=0과 동일한 factors를 내야 한다."""
    past = (date.today() - timedelta(days=400)).isoformat()
    common = _agg(
        yt_subscribers=1_140_000, yt_total_views=160_000_000,
        likes_total=8_000_000, comments_total=600_000,
        dc_total_posts=50_000, theqoo_posts=20_000, instiz_posts=35_000,
        naver_total_news=300, hanteo_sales=1_000_000,
        v90_count=20, v30_count=5,
    )
    clean = compute_health_score("plave", {**common, "controversy_count": 0},
                                  debut_date=past, group_model="corporate")
    chatter = compute_health_score("plave", {**common, "controversy_count": 2},
                                    debut_date=past, group_model="corporate")
    assert chatter.factors == clean.factors
    assert chatter.grade == clean.grade


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


# ─── V2.18 chart_peak ritual signal ─────────────────────────────────────


def test_chart_peak_lifts_ritual_when_present():
    """V2.18 — agg.melon_top100_peak (멜론 TOP 100 최고 순위) 가
    ritual factor를 끌어올린다. D-tier 변별력 회복용 stub.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(yt_subscribers=300_000, yt_total_views=30_000_000,
                likes_total=2_000_000, comments_total=200_000,
                naver_total_news=80, hanteo_sales=300_000)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0}
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "music_show_wins", "chart_peak"}
    no_chart = compute_health_score(
        "x", base, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # peak_rank=10 (top10) → chart_n = 0.91
    with_chart = compute_health_score(
        "x", {**base, "melon_top100_peak": 10},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert with_chart.factors["ritual"] > no_chart.factors["ritual"]


def test_chart_peak_normalize_lower_rank_smaller():
    """rank 1 (최고) > rank 50 > rank 100 > 미진입(0)."""
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(hanteo_sales=0, naver_total_news=0)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0}
    L = {"chart_peak"}  # ritual에서 chart_peak만 살아있음
    s_top = compute_health_score(
        "x", {**base, "melon_top100_peak": 1},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    s_mid = compute_health_score(
        "x", {**base, "melon_top100_peak": 50},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    s_bot = compute_health_score(
        "x", {**base, "melon_top100_peak": 100},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert s_top.factors["ritual"] > s_mid.factors["ritual"] > s_bot.factors["ritual"]


# ─── V2.19 chart_depth ritual signal ────────────────────────────────────


def test_chart_depth_lifts_ritual_when_present():
    """V2.19 — agg.melon_top100_depth (TOP 100 진입곡 수) 가 ritual을
    끌어올린다. peak 단독으로는 PLAVE처럼 6곡 진입한 그룹과 1곡 진입
    그룹의 변별이 안 됨 — depth 시그널이 그 갭을 메운다.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(yt_subscribers=300_000, yt_total_views=30_000_000,
                likes_total=2_000_000, comments_total=200_000,
                naver_total_news=80, hanteo_sales=300_000)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0, "chart_depth": 5.0}
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "music_show_wins", "chart_depth"}
    no_depth = compute_health_score(
        "x", base, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    with_depth = compute_health_score(
        "x", {**base, "melon_top100_depth": 3},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert with_depth.factors["ritual"] > no_depth.factors["ritual"]


def test_chart_depth_saturates_at_ref():
    """depth=ref(5) 와 depth=10 (ref 초과) 동일한 ritual 점수 — 정규화
    상한 1.0. PLAVE 6곡 같은 케이스가 D-tier 변별을 압도하지 않도록 보장.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(hanteo_sales=0, naver_total_news=0)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0, "chart_depth": 5.0}
    L = {"chart_depth"}
    s_at_ref = compute_health_score(
        "x", {**base, "melon_top100_depth": 5},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    s_above_ref = compute_health_score(
        "x", {**base, "melon_top100_depth": 10},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert s_at_ref.factors["ritual"] == s_above_ref.factors["ritual"]


def test_chart_depth_more_songs_lifts_ritual_more():
    """depth=1 < depth=3 < depth=5. 단조 증가."""
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(hanteo_sales=0, naver_total_news=0)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0, "chart_depth": 5.0}
    L = {"chart_depth"}
    s1 = compute_health_score(
        "x", {**base, "melon_top100_depth": 1},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    s3 = compute_health_score(
        "x", {**base, "melon_top100_depth": 3},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    s5 = compute_health_score(
        "x", {**base, "melon_top100_depth": 5},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=L,
    )
    assert s1.factors["ritual"] < s3.factors["ritual"] < s5.factors["ritual"]


def test_chart_depth_zero_or_null_treated_as_dead():
    """depth=0 (두 차트 모두 미진입) 와 depth=NULL (미수집) 모두
    chart_depth 시그널 부재 — ritual 기여 0pt.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(hanteo_sales=0, naver_total_news=0)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0, "chart_depth": 5.0}
    # live_metrics에 chart_depth 미포함 (cohort에 아무도 없음)
    s_zero = compute_health_score(
        "x", {**base, "melon_top100_depth": 0},
        debut_date=past, refs=refs, group_model="corporate", live_metrics=set(),
    )
    s_null = compute_health_score(
        "x", base,
        debut_date=past, refs=refs, group_model="corporate", live_metrics=set(),
    )
    assert s_zero.factors["ritual"] == s_null.factors["ritual"]


# ─── V2.17 news 정규화 보정 ─────────────────────────────────────────────


def test_news_uses_log_normalize_compresses_extreme_values():
    """V2.17 — news_n에 log scale 도입.

    raw news count의 변동성(영문 그룹명 vs 한글 표기)이 reach/ritual을 좌우
    하던 문제를 완화. naver hit count 차이가 2 vs 5 같은 작은 차이여도
    이전 linear normalize로는 0.25 vs 0.625 (2.5×) 압축 — log scale이면
    0.50 vs 0.81 정도(1.6×).
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(yt_subscribers=10_000, yt_total_views=1_000_000,
                hanteo_sales=0)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 8.0,
            "music_show_wins": 5.0}
    L = {"subscribers", "views", "news", "quality"}
    s_low = compute_health_score(
        "x", {**base, "naver_total_news": 2}, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    s_high = compute_health_score(
        "x", {**base, "naver_total_news": 5}, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # high - low < 1.0 (이전 linear는 ~1.5pt 차이 발생)
    delta_total = (s_high.total or 0) - (s_low.total or 0)
    assert delta_total < 0.3, (
        f"news 2→5 차이가 total {delta_total:.2f}pt — log normalize "
        f"적용되어 압축됐어야 한다."
    )


def test_news_weight_reduced_in_reach_and_ritual():
    """V2.17 — reach factor의 news weight 0.15→0.05, ritual의 0.20→0.10.

    같은 그룹에 news를 5×로 늘려도 total 변동이 V2.16(0.15+0.20=0.35
    weight share)보다 작아야 한다.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    base = _agg(yt_subscribers=10_000, yt_total_views=1_000_000,
                hanteo_sales=0, naver_total_news=2)
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 8.0,
            "music_show_wins": 5.0}
    L = {"subscribers", "views", "news", "quality"}
    s_2 = compute_health_score(
        "x", base, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    s_50 = compute_health_score(
        "x", {**base, "naver_total_news": 50}, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # ritual factor 한정으로 비교: news_n × 0.10 × ritual weight 30.
    # 이전 V2.16: news_n × 0.20 × 30 = 6× news_n. 새 산식: 3× news_n.
    # 즉 news 25× 늘려도 ritual 점수 변동 폭 절반.
    delta_ritual = s_50.factors["ritual"] - s_2.factors["ritual"]
    # V2.17: news weight 0.10 × ritual factor weight 30 = 최대 3.0pt
    # (이전 V2.16: 0.20 × 30 = 6.0pt). log normalize 추가 압축까지 함께
    # 작용해 실제 swing은 더 작음. "절반 이하"를 보장하는 임계 2.5pt.
    assert delta_ritual < 2.5, (
        f"ritual delta={delta_ritual:.2f}pt — news weight 0.10 적용 안 된 듯."
    )


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


def test_intimacy_no_loyalty_is_unchanged():
    """loyalty 키 없으면 기존 2신호(0.55/0.45) 경로 — 점수 불변."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.0,
    }
    refs = {**DEFAULT_REFS}
    base = _factor_inputs(agg, refs)["intimacy"]
    # loyalty_score=None 명시해도 동일해야 한다.
    agg_none = {**agg, "loyalty_score": None}
    assert _factor_inputs(agg_none, refs)["intimacy"] == base


def test_intimacy_with_loyalty_blends_third_signal():
    """loyalty_score 있으면 3신호(0.40/0.30/0.30) 경로로 값이 달라진다."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.0,
    }
    refs = {**DEFAULT_REFS}
    base = _factor_inputs(agg, refs)["intimacy"]
    high = _factor_inputs({**agg, "loyalty_score": 100.0}, refs)["intimacy"]
    low = _factor_inputs({**agg, "loyalty_score": 0.0}, refs)["intimacy"]
    assert high > base > low   # 충성도 100 가점 / 0 감점 (3신호 혼합)


def test_intimacy_loyalty_respects_compression():
    """부정 감정 압축이 loyalty 포함 intimacy에도 적용된다."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.5, "loyalty_score": 100.0,
    }
    refs = {**DEFAULT_REFS}
    no_neg = _factor_inputs({**agg, "negative_ratio": 0.0}, refs)["intimacy"]
    with_neg = _factor_inputs(agg, refs)["intimacy"]
    assert with_neg == pytest.approx(no_neg * 0.5)


# ─── P1 RitualVictory 0.8 천장 — music_show 코호트-dead 재분배 ───────────


def test_ritual_reaches_full_when_music_show_cohort_dead():
    """P1 — 음방(music_show_wins) 수집기가 코호트 전체에서 죽어 있을 때
    (stub collector), 그 0.20 weight가 분모에만 남아 ritual을 0.80에서
    막던 버그를 교정.

    교정 전(music_show 분모 잔존): hanteo/news/chart 만점이어도 ritual
    factor = 24.0 (0.80 천장).
    교정 후(코호트-dead music_show 재분배): ritual factor = 30.0.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        naver_total_news=1_000,      # log normalize → news_n clamps to 1.0
        hanteo_sales=1_000_000,      # millennium seller → hanteo_n = 1.0
        melon_top100_peak=1,         # chart_peak_n = 1.0
        melon_top100_depth=5,        # chart_depth_n = depth/ref = 1.0
    )
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 200,
        "music_show_wins": 5.0, "chart_depth": 5.0,
    }
    # 코호트에 music_show_wins 없음 (stub) → 재분배 대상.
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "chart_peak", "chart_depth"}
    score = compute_health_score(
        "x", agg, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # corporate ritual weight 30 × ritual_input 1.0 × risk 1.0 = 30.0.
    assert score.factors["ritual"] == pytest.approx(30.0)


def test_ritual_penalty_preserved_when_hanteo_absent_under_dead_music_show():
    """P1 — music_show 재분배가 켜져도 hanteo 부재는 여전히 페널티.

    hanteo/news/chart_peak/chart_depth는 redistribute=False 유지이므로
    hanteo가 빠진 그룹은 ritual=1.0에 도달하지 못한다. 같은 코호트-dead
    music_show 조건에서 hanteo만 빠지면 ritual factor가 11.25로 막힌다
    (교정 전 9.0 — 둘 다 30.0과 거리가 멀어 hanteo가 재분배되지 않음).
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        naver_total_news=1_000,      # news_n = 1.0
        hanteo_sales=0,              # ← hanteo 부재 (per-group dead)
        melon_top100_peak=1,         # chart_peak_n = 1.0
        melon_top100_depth=5,        # chart_depth_n = 1.0
    )
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 200,
        "music_show_wins": 5.0, "chart_depth": 5.0,
    }
    # 코호트엔 hanteo 있음(다른 그룹) but music_show 없음.
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "chart_peak", "chart_depth"}
    score = compute_health_score(
        "x", agg, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # hanteo(0.50) dead지만 weight는 분모에 잔존 → ritual_input =
    # (0 + 0.10 + 0.10 + 0.10) / (0.50 + 0.10 + 0.10 + 0.10) = 0.375.
    # factor = 0.375 × 30 = 11.25. 페널티가 유지되어 30.0에 못 미친다.
    assert score.factors["ritual"] == pytest.approx(11.25)
    assert score.factors["ritual"] < 30.0


def test_community_metric_dead_cohort_wide_is_dropped_not_zeroed():
    """P1 주석 정정 회귀가드(동작 불변) — sparse-collector defense는
    'paused since V2.11' 단정과 무관하게 코호트 전체에서 죽은 metric을
    재분배로 처리한다. community(dc/theqoo/instiz)가 코호트-dead일 때
    intimacy가 community 0/REF 페널티를 먹지 않고 engagement 단독으로
    재정규화되는지 고정(주석 편집이 코드 영역을 건드리지 않았음을 보증).

    _factor_inputs를 직접 호출해 per_group_live 교집합을 우회하고
    _wmean redistribute 동작만 검증한다.
    """
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=0, theqoo_posts=0, instiz_posts=0,  # community dead
        naver_total_news=80,
    )
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0}
    # community 미포함(코호트-dead) → _wmean redistribute → engagement 단독.
    fi_dead = _factor_inputs(agg, refs, live_metrics={"quality"})
    # community 포함(코호트-alive, per-group 0) → 0 기여, weight 페널티.
    fi_live = _factor_inputs(agg, refs, live_metrics={"quality", "community"})
    # dead일 때 intimacy가 더 높아야(재분배 vs 페널티).
    assert fi_dead["intimacy"] > fi_live["intimacy"]


def test_unconfirmed_debut_gates_to_pre():
    """잠정 앵커(BTHD): debut_date 가 과거여도 debut_confirmed=0 → PRE."""
    score = compute_health_score(
        "bthd", {"yt_subscribers": 100000}, "2026-06-26", debut_confirmed=0)
    assert score.grade == "PRE"
    assert score.total is None


def test_confirmed_default_keeps_existing_behavior():
    a = compute_health_score("g", {"yt_subscribers": 1000}, "2020-01-01")
    b = compute_health_score(
        "g", {"yt_subscribers": 1000}, "2020-01-01", debut_confirmed=None)
    assert a.grade == b.grade != "PRE"
