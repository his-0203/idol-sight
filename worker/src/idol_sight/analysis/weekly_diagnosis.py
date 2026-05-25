"""Causal Diagnosis 오케스트레이션.

`weekly_diagnosis_signals` 의 raw 시그널 → 11개 가설 카탈로그 →
confidence → 메타가드 적용 → `GroupSignals` dataclass.

이 모듈은 DB 접근 추상화 (`_Executor` Protocol) 를 통해 raw row 만
의존한다. `compute_group_signals(db, week_start, week_end)` 가 진입점.

가설 카탈로그: spec 2026-05-25-causal-diagnosis-design.md rev 2 §3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


HYPOTHESIS_KEYS: tuple[str, ...] = (
    "organic_growth",
    "paid_youtube_ads",
    "subscriber_purchase",
    "comeback_cycle",
    "broadcast_appearance",
    "community_word_of_mouth",
    "controversy_spike",
    "platform_concentrated_promo",
    "member_centric_spike",
    "insufficient_signal",
)

CONFIDENCE_LEVELS: tuple[str, ...] = ("high", "medium", "low")


@dataclass
class Evidence:
    key: str
    value: Any
    label: str


@dataclass
class Hypothesis:
    key: str
    confidence: str            # 'high' | 'medium' | 'low'
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class GroupSignals:
    group_key: str
    hypotheses: list[Hypothesis] = field(default_factory=list)
    meta_guards: list[str] = field(default_factory=list)
    deltas: dict[str, float] = field(default_factory=dict)
    organicity: dict[str, Any] | None = None


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


# 점등 임계치 — spec rev 2 §3 의 본 카탈로그.
Z_THRESHOLD_PRIMARY = 1.5
Z_THRESHOLD_STRONG = 2.0
ER_DROP_PAID_THRESHOLD = -0.20      # ER WoW 가 이만큼 떨어지면 paid 의심
ER_DROP_SUB_PURCHASE_THRESHOLD = -0.25
VPS_DROP_SUB_PURCHASE = -0.30
ORGANICITY_PAID_THRESHOLD = 0.30
SUBS_Z_SUB_PURCHASE = 2.5


def _check_organic_growth(sig: dict) -> Hypothesis | None:
    # ER 시그널이 없으면 (신규 그룹의 prev_er=0 등) "ER 안정" 단정 불가 → organic 차단.
    # MiiWAN 데뷔 첫 주 같은 경우에 false positive 차단 (spec rev 2 §3.1 의 organic 조건 "ER 안정" 강제).
    er_wow = sig.get("er_wow")
    if er_wow is None:
        return None
    # ER 불안정 시 (절대값 ≥ 15%) organic 제외 — 광고/구매 의심을 못 배제.
    if abs(er_wow) >= 0.15:
        return None
    lit_signals: list[Evidence] = []
    if sig["subs_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("subs_z", sig["subs_z"], f"구독 z={sig['subs_z']:.1f}"))
    if sig["views_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("views_z", sig["views_z"], f"조회 z={sig['views_z']:.1f}"))
    if sig["news_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("news_z", sig["news_z"], f"뉴스 z={sig['news_z']:.1f}"))
    if sig["community_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("community_z", sig["community_z"], f"커뮤 z={sig['community_z']:.1f}"))
    if sig["market_share_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("market_share_z", sig["market_share_z"], f"share z={sig['market_share_z']:.1f}"))
    if len(lit_signals) < 4:
        return None
    return Hypothesis(key="organic_growth", confidence="high", evidence=lit_signals)


def _check_paid_youtube_ads(sig: dict) -> Hypothesis | None:
    er_wow = sig.get("er_wow") or 0.0
    evidence: list[Evidence] = []
    score = 0
    if sig["views_z"] >= Z_THRESHOLD_STRONG:
        evidence.append(Evidence("views_z", sig["views_z"], f"조회 z={sig['views_z']:.1f}"))
        score += 1
    # subs 가 views 만큼 따라오지 않음 — 핵심 변별
    if sig["views_z"] >= Z_THRESHOLD_PRIMARY and sig["subs_z"] < Z_THRESHOLD_PRIMARY:
        evidence.append(Evidence(
            "subs_views_gap",
            sig["views_z"] - sig["subs_z"],
            f"subs 비례 안 함 (views z={sig['views_z']:.1f}, subs z={sig['subs_z']:.1f})",
        ))
        score += 1
    if er_wow <= ER_DROP_PAID_THRESHOLD:
        evidence.append(Evidence(
            "engagement_rate_wow",
            er_wow,
            f"ER WoW {er_wow:+.0%}",
        ))
        score += 1
    if sig["organicity_paid"] is not None and sig["organicity_paid"] >= ORGANICITY_PAID_THRESHOLD:
        evidence.append(Evidence(
            "organicity_paid_ratio",
            sig["organicity_paid"],
            f"신규 영상 paid 의심 {sig['organicity_paid']:.0%}",
        ))
        score += 1
    if sig.get("video_tags_paid_match"):
        evidence.append(Evidence(
            "video_tags_paid_match", True,
            "광고성 영상 태그 패턴 매칭",
        ))
        # video_tags 는 약신호 — score 에 0.5 만 (실제 구현 시 점등 보조)
    if score < 3:
        return None
    confidence = "high" if score >= 3 else "medium"
    return Hypothesis(key="paid_youtube_ads", confidence=confidence, evidence=evidence)


def _check_subscriber_purchase(sig: dict) -> Hypothesis | None:
    er_wow = sig.get("er_wow") or 0.0
    evidence: list[Evidence] = []
    score = 0
    if sig["subs_z"] >= SUBS_Z_SUB_PURCHASE:
        evidence.append(Evidence("subs_z", sig["subs_z"], f"구독 z={sig['subs_z']:.1f}"))
        score += 1
    if sig.get("vps_wow") is not None and sig["vps_wow"] <= VPS_DROP_SUB_PURCHASE:
        evidence.append(Evidence(
            "views_per_sub_wow", sig["vps_wow"],
            f"views/sub WoW {sig['vps_wow']:+.0%}",
        ))
        score += 1
    if er_wow <= ER_DROP_SUB_PURCHASE_THRESHOLD:
        evidence.append(Evidence(
            "engagement_rate_wow", er_wow,
            f"ER WoW {er_wow:+.0%}",
        ))
        score += 1
    # vps_wow 가 None 이면 핵심 변별 시그널 없음 — 점등 차단
    if sig.get("vps_wow") is None:
        return None
    if score < 3:
        return None
    # subscriber_purchase 는 검증 어려움 → 항상 medium 캡.
    return Hypothesis(key="subscriber_purchase", confidence="medium", evidence=evidence)


def _check_comeback_cycle(sig: dict) -> Hypothesis | None:
    cb = sig["comeback"]
    evidence: list[Evidence] = []
    score = 0
    if cb.get("hanteo_sales") and cb["hanteo_sales"] > 0:
        evidence.append(Evidence(
            "hanteo_sales", cb["hanteo_sales"],
            f"한터 초동 {cb['hanteo_sales']:,}장",
        ))
        score += 1
    if cb.get("chart_peak") is not None and cb["chart_peak"] <= 30:
        evidence.append(Evidence(
            "chart_peak", cb["chart_peak"],
            f"멜론 TOP100 peak #{cb['chart_peak']}",
        ))
        score += 1
    if cb.get("music_streak", 0) >= 3:
        evidence.append(Evidence(
            "music_show_streak", cb["music_streak"],
            f"음방 {cb['music_streak']}연속 1위",
        ))
        score += 1
    if sig["news_z"] >= Z_THRESHOLD_STRONG:
        evidence.append(Evidence("news_z", sig["news_z"], f"뉴스 z={sig['news_z']:.1f}"))
        score += 1
    if cb.get("video_upload_z", 0) >= Z_THRESHOLD_PRIMARY:
        evidence.append(Evidence(
            "video_upload_z", cb["video_upload_z"],
            f"영상 업로드 z={cb['video_upload_z']:.1f}",
        ))
        score += 1
    if cb.get("event_match"):
        evidence.append(Evidence(
            "group_events_match", cb["event_match"],
            f"group_events ground truth: {cb['event_match'].get('title')}",
        ))
        # group_events 매칭은 confidence 부스트 (score +1 효과)
        score += 1
    if score < 2:
        return None
    # ground truth 매칭 시 high 보장
    confidence = "high" if score >= 3 or cb.get("event_match") else "medium"
    return Hypothesis(key="comeback_cycle", confidence=confidence, evidence=evidence)


def _confidence_dampen(c: str) -> str:
    """한 단계 감점. high → medium, medium → low, low → low."""
    idx = CONFIDENCE_LEVELS.index(c) if c in CONFIDENCE_LEVELS else 2
    return CONFIDENCE_LEVELS[min(idx + 1, 2)]


def _dampen_if_comeback_active(hyps: list[Hypothesis]) -> list[Hypothesis]:
    """comeback_cycle 이 점등돼 있으면 paid_ads / subscriber_purchase confidence 감점."""
    comeback_active = any(h.key == "comeback_cycle" and h.confidence in ("high", "medium")
                          for h in hyps)
    if not comeback_active:
        return hyps
    dampened: list[Hypothesis] = []
    for h in hyps:
        if h.key in ("paid_youtube_ads", "subscriber_purchase"):
            new_conf = _confidence_dampen(h.confidence)
            if new_conf == "low":
                continue   # low 면 emit 안 함
            dampened.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
        else:
            dampened.append(h)
    return dampened


def _check_broadcast_appearance(sig: dict) -> Hypothesis | None:
    """전주 news z>=3 + 이번 주 community z>=1.5 + community_keywords 가 external."""
    prev_news = sig.get("news_z_prev_week", 0.0)
    if prev_news < 3.0:
        return None
    if sig["community_z"] < Z_THRESHOLD_PRIMARY:
        return None
    evidence = [
        Evidence("news_z_prev_week", prev_news, f"전주 뉴스 z={prev_news:.1f} 단발"),
        Evidence("community_z", sig["community_z"], f"이번 주 커뮤 z={sig['community_z']:.1f}"),
    ]
    if sig.get("community_keywords_topic") == "external":
        evidence.append(Evidence(
            "community_keywords_topic", "external",
            "커뮤 키워드: 외부 매체/방송명 우세",
        ))
    return Hypothesis(key="broadcast_appearance", confidence="medium", evidence=evidence)


def _check_community_word_of_mouth(sig: dict) -> Hypothesis | None:
    """전주 community spike + 이번 주 subs/view 따라옴 + 자체 콘텐츠 토픽."""
    prev_comm = sig.get("community_z_prev_week", 0.0)
    if prev_comm < Z_THRESHOLD_STRONG:
        return None
    if sig["subs_z"] < Z_THRESHOLD_PRIMARY and sig["views_z"] < Z_THRESHOLD_PRIMARY:
        return None
    evidence = [
        Evidence("community_z_prev_week", prev_comm,
                 f"전주 커뮤 z={prev_comm:.1f} 선행"),
        Evidence("subs_views_followup",
                 max(sig["subs_z"], sig["views_z"]),
                 f"이번 주 구독/조회 동반 (max z={max(sig['subs_z'], sig['views_z']):.1f})"),
    ]
    if sig.get("community_keywords_topic") == "self":
        evidence.append(Evidence(
            "community_keywords_topic", "self",
            "커뮤 키워드: 자체 콘텐츠 우세",
        ))
    return Hypothesis(key="community_word_of_mouth", confidence="medium", evidence=evidence)


CONTROVERSY_Z_THRESHOLD = 2.0


def _check_controversy_spike(sig: dict) -> Hypothesis | None:
    co = sig["controversy"]
    evidence: list[Evidence] = []
    if co["controversy_count_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "controversy_count_z", co["controversy_count_z"],
            f"controversy 트윗 z={co['controversy_count_z']:.1f}",
        ))
    if co["negative_ratio_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "negative_ratio_z", co["negative_ratio_z"],
            f"부정 감성 비율 z={co['negative_ratio_z']:.1f}",
        ))
    if co["twitter_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "twitter_controversy_z", co["twitter_z"],
            f"트위터 controversy type z={co['twitter_z']:.1f}",
        ))
    if co["keyword_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "negative_keyword_z", co["keyword_z"],
            f"커뮤 부정 키워드 z={co['keyword_z']:.1f}",
        ))
    if not evidence:
        return None
    # 시그널 하나라도 점등 → high (인간 검증 강제 — prompts.py 가 streisand 가드 첨부)
    return Hypothesis(key="controversy_spike", confidence="high", evidence=evidence)


def _check_platform_concentrated(sig: dict) -> Hypothesis | None:
    dom_name, dom_ratio = sig["reactivity_dominant"]
    if dom_name is None:
        return None
    # 보조 시그널: 같은 플랫폼에 해당하는 z 가 점등돼야 함
    if dom_name == "naver":
        support_z = sig["news_z"]
    else:
        support_z = sig["community_z"]
    if support_z < Z_THRESHOLD_STRONG:
        return None
    evidence = [
        Evidence(
            "reactivity_dominant", dom_name,
            f"{dom_name} 단독 reactivity {dom_ratio:.1f}×",
        ),
        Evidence(
            f"{dom_name}_z", support_z,
            f"{dom_name} 지표 z={support_z:.1f}",
        ),
    ]
    # 보조 z 가 매우 강하면 high, 아니면 medium
    confidence = "high" if support_z >= 2.5 else "medium"
    return Hypothesis(key="platform_concentrated_promo", confidence=confidence, evidence=evidence)


def _check_member_centric_spike(sig: dict) -> Hypothesis | None:
    mc = sig["member_centric"]
    if mc.get("dead") or not mc.get("lit"):
        return None
    evidence: list[Evidence] = []
    if mc.get("top1_share_wow") is not None and mc["top1_share_wow"] >= 0.10:
        evidence.append(Evidence(
            "top1_share_wow", mc["top1_share_wow"],
            f"멤버 1 인기 +{mc['top1_share_wow']*100:.0f}pt",
        ))
    if mc.get("hhi_norm_wow") is not None and mc["hhi_norm_wow"] >= 0.15:
        evidence.append(Evidence(
            "hhi_norm_wow", mc["hhi_norm_wow"],
            f"인기 집중도 +{mc['hhi_norm_wow']:.2f}",
        ))
    # 그룹 차원 spike 가 동반돼야 의미 있는 가설
    if sig["subs_z"] < Z_THRESHOLD_PRIMARY and sig["views_z"] < Z_THRESHOLD_PRIMARY:
        return None
    if not evidence:
        return None
    confidence = "high" if mc.get("top1_share_high") else "medium"
    return Hypothesis(key="member_centric_spike", confidence=confidence, evidence=evidence)


def _dampen_if_member_centric_active(hyps: list[Hypothesis]) -> list[Hypothesis]:
    """member_centric_spike 점등 시 그룹-차원 paid/sub_purchase confidence 감점."""
    mc_active = any(h.key == "member_centric_spike" and h.confidence in ("high", "medium")
                    for h in hyps)
    if not mc_active:
        return hyps
    out: list[Hypothesis] = []
    for h in hyps:
        if h.key in ("paid_youtube_ads", "subscriber_purchase"):
            new_conf = _confidence_dampen(h.confidence)
            if new_conf == "low":
                continue
            out.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
        else:
            out.append(h)
    return out


def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    """시그널 dict → 점등된 가설 리스트. 점등 안 된 가설은 omit.

    confidence 정렬은 후속 단계 (`compute_group_signals`) 에서 처리.
    """
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
        _check_subscriber_purchase(sig),
        _check_comeback_cycle(sig),
        _check_broadcast_appearance(sig),
        _check_community_word_of_mouth(sig),
        _check_controversy_spike(sig),
        _check_platform_concentrated(sig),
        _check_member_centric_spike(sig),
    ]
    lit = [c for c in candidates if c is not None]
    lit = _dampen_if_comeback_active(lit)
    lit = _dampen_if_member_centric_active(lit)
    return lit


def apply_meta_guards(
    hyps: list[Hypothesis],
    *,
    irrelevant_ratio: float,
    data_source_warning: bool,
) -> tuple[list[Hypothesis], list[str]]:
    """data_credibility_warning 메타가드 적용 — 모든 가설 confidence 한 단계 감점.

    Returns:
      (수정된 hypotheses, 점등된 메타가드 라벨 리스트)
    """
    guards: list[str] = []
    from idol_sight.analysis.weekly_diagnosis_signals import IRRELEVANT_RATIO_THRESHOLD
    if irrelevant_ratio >= IRRELEVANT_RATIO_THRESHOLD:
        guards.append(f"irrelevant_flagged_{irrelevant_ratio:.0%}")
    if data_source_warning:
        guards.append("data_source_backfill_majority")
    if not guards:
        return hyps, []
    out: list[Hypothesis] = []
    for h in hyps:
        new_conf = _confidence_dampen(h.confidence)
        # low 가 되더라도 emit (메타가드는 카드 자체를 차단하지 않음 — body 에 경고만 첨부)
        out.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
    return out, guards


from idol_sight.analysis import weekly_diagnosis_signals as _S


def compute_group_signals(
    *, db: _Executor, week_start: str, week_end: str,
) -> dict[str, GroupSignals]:
    """진입점 — DB executor 로부터 raw row 를 모아 GroupSignals dict 생성.

    SQL 쿼리 개수: 10개 (test_compute_group_signals 의 stub 순서와 일치).
    실제 운영 환경에서는 build_context 가 미리 일부를 모아둘 수도 있지만,
    이 함수는 standalone 호출 가능하도록 자체 쿼리한다.
    """
    last_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    prev_start = _shift_iso_date(week_start, -7)
    prev_end = _shift_iso_date(week_end, -7)
    prev_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, prev_end],
    )
    organicity_rows = db.execute(
        "SELECT group_key, verdict FROM debut_window_video_organicity "
        "WHERE substr(published_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    events_rows = db.execute(
        "SELECT group_key, event_date, event_type, title FROM group_events "
        "WHERE event_date BETWEEN ? AND ?",
        [_shift_iso_date(week_start, -7), _shift_iso_date(week_end, 7)],
    )
    music_show_rows = db.execute(
        "SELECT group_key, show, song_title, win_date "
        "FROM music_show_wins_log "
        "WHERE win_date BETWEEN ? AND ?",
        [week_start, week_end],
    )
    comm_kw_now = db.execute(
        "SELECT group_key, keyword, count FROM community_keywords "
        "WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    comm_kw_past = db.execute(
        "SELECT group_key, "
        "  substr(snapshot_at, 1, 10) AS day, "
        "  SUM(count) AS neg_total "
        "FROM community_keywords "
        "WHERE keyword IN (" + ",".join("?" * len(_S.NEGATIVE_KEYWORDS)) + ") "
        "  AND substr(snapshot_at, 1, 10) < ? "
        "GROUP BY group_key, day "
        "ORDER BY day DESC LIMIT 70",
        [*_S.NEGATIVE_KEYWORDS, week_start],
    )
    twitter_rows = db.execute(
        "SELECT group_key, "
        "  substr(posted_at, 1, 10) AS day, "
        "  COUNT(*) AS n "
        "FROM twitter_posts WHERE type='controversy' "
        "  AND substr(posted_at, 1, 10) < ? "
        "GROUP BY group_key, day ORDER BY day DESC LIMIT 70",
        [week_end],
    )
    irrelevant_rows = db.execute(
        "SELECT group_key, user_flagged_irrelevant "
        "FROM community_posts "
        "WHERE substr(collected_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    member_pop_rows = db.execute(
        "SELECT group_key, snapshot_at, top1_share, top3_share, hhi_norm "
        "FROM agg_member_pop_meta "
        "WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, week_end],
    )

    # group_key → row 매핑. 같은 group_key 에 여러 snapshot 이 있으면
    # snapshot_at 가장 최근 row 만 남긴다 (정렬 후 last-wins).
    now_by: dict[str, dict] = {}
    for r in sorted(last_7d, key=lambda x: x.get("snapshot_at") or ""):
        if r.get("group_key"):
            now_by[r["group_key"]] = r
    prev_by: dict[str, dict] = {}
    for r in sorted(prev_7d, key=lambda x: x.get("snapshot_at") or ""):
        if r.get("group_key"):
            prev_by[r["group_key"]] = r

    # cohort lists (z-score 분모) — 그룹당 1 row 의 dict 에서 생성.
    # 멀티-스냅 가중치 회피.
    now_rows = list(now_by.values())
    subs_cohort      = [float(r.get("yt_subscribers")  or 0) for r in now_rows]
    views_cohort     = [float(r.get("yt_total_views")  or 0) for r in now_rows]
    news_cohort      = [float(r.get("naver_total_news") or 0) for r in now_rows]
    community_cohort = [
        float((r.get("dc_total_posts") or 0)
              + (r.get("theqoo_posts") or 0)
              + (r.get("instiz_posts") or 0))
        for r in now_rows
    ]
    controversy_count_cohort = [float(r.get("controversy_count") or 0) for r in now_rows]
    negative_ratio_cohort    = [float(r.get("negative_ratio")   or 0) for r in now_rows]
    organicity_by: dict[str, list[dict]] = {}
    for r in organicity_rows:
        organicity_by.setdefault(r["group_key"], []).append(r)
    events_by: dict[str, list[dict]] = {}
    for r in events_rows:
        events_by.setdefault(r["group_key"], []).append(r)
    music_show_by: dict[str, list[dict]] = {}
    for r in music_show_rows:
        music_show_by.setdefault(r["group_key"], []).append(r)
    comm_kw_now_by: dict[str, list[dict]] = {}
    for r in comm_kw_now:
        comm_kw_now_by.setdefault(r["group_key"], []).append(r)
    comm_kw_past_by: dict[str, list[float]] = {}
    for r in comm_kw_past:
        gk = r.get("group_key")
        if gk is None:
            continue
        comm_kw_past_by.setdefault(gk, []).append(float(r.get("neg_total") or 0))
    twitter_by: dict[str, list[float]] = {}
    for r in twitter_rows:
        gk = r.get("group_key")
        if gk is None:
            continue
        twitter_by.setdefault(gk, []).append(float(r.get("n") or 0))
    irrelevant_by: dict[str, list[dict]] = {}
    for r in irrelevant_rows:
        irrelevant_by.setdefault(r["group_key"], []).append(r)
    member_pop_by: dict[str, list[dict]] = {}
    for r in member_pop_rows:
        member_pop_by.setdefault(r["group_key"], []).append(r)

    out: dict[str, GroupSignals] = {}
    for gk, now in now_by.items():
        prev = prev_by.get(gk, {})
        # member_pop now/prev 최신/이전 한 쌍
        mp_rows = sorted(member_pop_by.get(gk, []), key=lambda r: r.get("snapshot_at") or "")
        mp_now  = mp_rows[-1] if mp_rows else {}
        mp_prev = mp_rows[-2] if len(mp_rows) >= 2 else {}

        sig = {
            "subs_z":             _S.cohort_z_score(float(now.get("yt_subscribers") or 0), subs_cohort),
            "views_z":            _S.cohort_z_score(float(now.get("yt_total_views") or 0), views_cohort),
            "news_z":             _S.cohort_z_score(float(now.get("naver_total_news") or 0), news_cohort),
            "community_z":        _S.cohort_z_score(
                float((now.get("dc_total_posts") or 0)
                      + (now.get("theqoo_posts") or 0)
                      + (now.get("instiz_posts") or 0)),
                community_cohort,
            ),
            "market_share_z":     0.0,    # V1: agg_market_share 별도 쿼리 — 후속 enhancement
            "er_wow":             _S.engagement_rate_wow_drop(now, prev),
            "vps_wow":            _S.views_per_sub_wow_drop(now, prev),
            "organicity_paid":    _S.organicity_paid_ratio(organicity_by.get(gk, [])),
            "reactivity_dominant": _S.reactivity_dominant_platform(now),
            "member_centric":     _S.member_centric_signals(mp_now, mp_prev),
            "comeback": {
                "event_match":     _S.group_event_within_window(
                    events_by.get(gk, []), week_start=week_start, week_end=week_end,
                ),
                "music_streak":    _S.music_show_consecutive_wins(music_show_by.get(gk, []))["consecutive"],
                "hanteo_sales":    0,    # V1: hanteo_weekly 별도 쿼리 — 후속
                "chart_peak":      now.get("melon_top100_peak"),
                "video_upload_z":  0.0,   # V1: youtube_videos 별도 쿼리 — 후속
            },
            "controversy": {
                "keyword_z":             _S.negative_keyword_z(
                    comm_kw_now_by.get(gk, []),
                    comm_kw_past_by.get(gk, []),
                ),
                "twitter_z":             _S.twitter_controversy_z(
                    now_count=int(now.get("twitter_posts") or 0),
                    cohort_counts=twitter_by.get(gk, []),
                ),
                "controversy_count_z":   _S.cohort_z_score(
                    float(now.get("controversy_count") or 0),
                    controversy_count_cohort,
                ),
                "negative_ratio_z":      _S.cohort_z_score(
                    float(now.get("negative_ratio") or 0),
                    negative_ratio_cohort,
                ),
            },
            "news_z_prev_week":           0.0,    # V1: 단순화 — 후속
            "community_z_prev_week":      0.0,    # V1: 단순화 — 후속
            "community_keywords_topic":   "neutral",   # V1: stub — 후속
            "video_tags_paid_match":      False,        # V1: stub — 후속
        }

        hyps = classify_hypotheses(sig)
        irrelevant_ratio = _S.irrelevant_flag_ratio(irrelevant_by.get(gk, []))
        backfill_warning = _S.data_source_warning(
            [r for r in last_7d if r["group_key"] == gk]
        )
        hyps, guards = apply_meta_guards(
            hyps,
            irrelevant_ratio=irrelevant_ratio,
            data_source_warning=backfill_warning,
        )

        out[gk] = GroupSignals(
            group_key=gk,
            hypotheses=hyps,
            meta_guards=guards,
            deltas={
                "subs_z":   sig["subs_z"],
                "views_z":  sig["views_z"],
                "news_z":   sig["news_z"],
                "er_wow":   sig["er_wow"] if sig["er_wow"] is not None else 0.0,
            },
            organicity={
                "paid_ratio": sig["organicity_paid"],
            } if sig["organicity_paid"] is not None else None,
        )
    return out


def _shift_iso_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()
