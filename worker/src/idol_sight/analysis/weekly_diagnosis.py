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

from idol_sight.analysis import weekly_diagnosis_signals as _S
from idol_sight.analysis.weekly_diagnosis_signals import IRRELEVANT_RATIO_THRESHOLD

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


def _is_lit(
    sig_entry: dict,
    *,
    z_threshold: float = Z_THRESHOLD_PRIMARY,
    wow_threshold: float,
) -> bool:
    """sig dict 의 한 entry (subs/views/news/community 형식) 가 3-축 OR 판정.

    sig_entry: {"category_z": float, "temporal_z": float, "wow_pct": float | None}
    셋 중 *하나만* 점등이면 True. routine 변동은 모든 축 미달, 진짜 spike 는
    어느 한 축에서 잡힘 — cohort 분포 비대칭 (kpop vs subculture) 영향 제거.
    """
    if sig_entry.get("category_z", 0.0) >= z_threshold:
        return True
    if sig_entry.get("temporal_z", 0.0) >= z_threshold:
        return True
    wow = sig_entry.get("wow_pct")
    return wow is not None and wow >= wow_threshold


def _evidence_3axis(
    name: str,
    entry: dict,
    *,
    z_threshold: float = Z_THRESHOLD_PRIMARY,
    wow_threshold: float,
) -> Evidence:
    """3-축 lit 시그널을 evidence label 로 풀어쓰기.

    어느 축에서 점등됐는지 카드 운영자가 직관적으로 알 수 있도록
    'category z=2.1, temporal z=1.8, WoW +6.2%' 같이 명시.
    """
    parts: list[str] = []
    cat_z = entry.get("category_z", 0.0) or 0.0
    tmp_z = entry.get("temporal_z", 0.0) or 0.0
    if cat_z >= z_threshold:
        parts.append(f"category z={cat_z:.1f}")
    if tmp_z >= z_threshold:
        parts.append(f"temporal z={tmp_z:.1f}")
    wow = entry.get("wow_pct")
    if wow is not None and wow >= wow_threshold:
        parts.append(f"WoW {wow:+.0%}")
    label = f"{name} spike — {', '.join(parts)}" if parts else f"{name} spike"
    return Evidence(name, dict(entry), label=label)


def _check_organic_growth(sig: dict) -> Hypothesis | None:
    # ER 시그널이 없으면 (신규 그룹의 prev_er=0 등) "ER 안정" 단정 불가 → organic 차단.
    # MiiWAN 데뷔 첫 주 같은 경우에 false positive 차단
    # (spec rev 2 §3.1 의 organic 조건 "ER 안정" 강제).
    er_wow = sig.get("er_wow")
    if er_wow is None:
        return None
    # ER 불안정 시 (절대값 ≥ 15%) organic 제외 — 광고/구매 의심을 못 배제.
    if abs(er_wow) >= 0.15:
        return None
    lit_signals: list[Evidence] = []
    if _is_lit(sig["subs"], wow_threshold=_S.SUBS_WOW_LIT):
        lit_signals.append(_evidence_3axis("subs", sig["subs"], wow_threshold=_S.SUBS_WOW_LIT))
    if _is_lit(sig["views"], wow_threshold=_S.VIEWS_WOW_LIT):
        lit_signals.append(_evidence_3axis("views", sig["views"], wow_threshold=_S.VIEWS_WOW_LIT))
    if _is_lit(sig["news"], wow_threshold=_S.NEWS_WOW_LIT):
        lit_signals.append(_evidence_3axis("news", sig["news"], wow_threshold=_S.NEWS_WOW_LIT))
    if _is_lit(sig["community"], wow_threshold=_S.COMMUNITY_WOW_LIT):
        lit_signals.append(_evidence_3axis("community", sig["community"],
                                           wow_threshold=_S.COMMUNITY_WOW_LIT))
    if sig["market_share_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("market_share_z", sig["market_share_z"],
                                    f"share z={sig['market_share_z']:.1f}"))
    if len(lit_signals) < 4:
        return None
    return Hypothesis(key="organic_growth", confidence="high", evidence=lit_signals)


def _check_paid_youtube_ads(sig: dict) -> Hypothesis | None:
    er_wow = sig.get("er_wow") or 0.0
    evidence: list[Evidence] = []
    score = 0
    views_entry = sig["views"]
    subs_entry = sig["subs"]
    if _is_lit(views_entry, z_threshold=Z_THRESHOLD_STRONG, wow_threshold=_S.VIEWS_WOW_PAID):
        evidence.append(_evidence_3axis(
            "views", views_entry,
            z_threshold=Z_THRESHOLD_STRONG, wow_threshold=_S.VIEWS_WOW_PAID,
        ))
        score += 1
    # subs 가 views 만큼 따라오지 않음 — 핵심 변별 (category z 기준)
    views_cat_z = views_entry.get("category_z", 0.0) or 0.0
    subs_cat_z = subs_entry.get("category_z", 0.0) or 0.0
    if views_cat_z >= Z_THRESHOLD_PRIMARY and subs_cat_z < Z_THRESHOLD_PRIMARY:
        evidence.append(Evidence(
            "subs_views_gap",
            views_cat_z - subs_cat_z,
            f"subs 비례 안 함 (views z={views_cat_z:.1f}, subs z={subs_cat_z:.1f})",
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
    subs_entry = sig["subs"]
    if _is_lit(
        subs_entry,
        z_threshold=SUBS_Z_SUB_PURCHASE,
        wow_threshold=_S.SUBS_WOW_SUB_PURCHASE,
    ):
        evidence.append(_evidence_3axis(
            "subs", subs_entry,
            z_threshold=SUBS_Z_SUB_PURCHASE,
            wow_threshold=_S.SUBS_WOW_SUB_PURCHASE,
        ))
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
    if _is_lit(
        sig["news"],
        z_threshold=Z_THRESHOLD_STRONG,
        wow_threshold=_S.NEWS_WOW_LIT,
    ):
        evidence.append(_evidence_3axis(
            "news", sig["news"],
            z_threshold=Z_THRESHOLD_STRONG, wow_threshold=_S.NEWS_WOW_LIT,
        ))
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


def _apply_dampen(
    hyps: list[Hypothesis],
    *,
    targets: set[str],
    reasons: set[str],
) -> list[Hypothesis]:
    """`targets` 안의 가설들을 한 단계만 감점 (이유 수와 무관).

    reasons 가 비어있으면 변경 없이 그대로 반환. low 로 떨어지면 emit 안 함.
    """
    if not reasons:
        return hyps
    out: list[Hypothesis] = []
    for h in hyps:
        if h.key in targets:
            new_conf = _confidence_dampen(h.confidence)
            if new_conf == "low":
                continue
            out.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
        else:
            out.append(h)
    return out


def _check_broadcast_appearance(sig: dict) -> Hypothesis | None:
    """전주 news z>=3 + 이번 주 community 시그널 점등 + community_keywords 가 external."""
    prev_news = sig.get("news_z_prev_week", 0.0)
    if prev_news < 3.0:
        return None
    if not _is_lit(sig["community"], wow_threshold=_S.COMMUNITY_WOW_LIT):
        return None
    evidence = [
        Evidence("news_z_prev_week", prev_news, f"전주 뉴스 z={prev_news:.1f} 단발"),
        _evidence_3axis("community", sig["community"], wow_threshold=_S.COMMUNITY_WOW_LIT),
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
    subs_lit = _is_lit(sig["subs"], wow_threshold=_S.SUBS_WOW_LIT)
    views_lit = _is_lit(sig["views"], wow_threshold=_S.VIEWS_WOW_LIT)
    if not subs_lit and not views_lit:
        return None
    evidence = [
        Evidence("community_z_prev_week", prev_comm,
                 f"전주 커뮤 z={prev_comm:.1f} 선행"),
    ]
    if subs_lit:
        evidence.append(_evidence_3axis(
            "subs", sig["subs"], wow_threshold=_S.SUBS_WOW_LIT,
        ))
    if views_lit:
        evidence.append(_evidence_3axis(
            "views", sig["views"], wow_threshold=_S.VIEWS_WOW_LIT,
        ))
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
    # 보조 시그널: 같은 플랫폼에 해당하는 3-축 지표가 점등돼야 함.
    # platform_concentrated 는 강한 신호 → STRONG z (또는 큰 WoW) 요구.
    if dom_name == "naver":
        support_entry = sig["news"]
        wow_th = _S.NEWS_WOW_LIT
    else:
        support_entry = sig["community"]
        wow_th = _S.COMMUNITY_WOW_LIT
    if not _is_lit(support_entry, z_threshold=Z_THRESHOLD_STRONG, wow_threshold=wow_th):
        return None
    max_z = max(
        support_entry.get("category_z", 0.0) or 0.0,
        support_entry.get("temporal_z", 0.0) or 0.0,
    )
    evidence = [
        Evidence(
            "reactivity_dominant", dom_name,
            f"{dom_name} 단독 reactivity {dom_ratio:.1f}×",
        ),
        _evidence_3axis(
            dom_name, support_entry,
            z_threshold=Z_THRESHOLD_STRONG, wow_threshold=wow_th,
        ),
    ]
    # 보조 z 가 매우 강하면 high, 아니면 medium
    confidence = "high" if max_z >= 2.5 else "medium"
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
    subs_lit = _is_lit(sig["subs"], wow_threshold=_S.SUBS_WOW_LIT)
    views_lit = _is_lit(sig["views"], wow_threshold=_S.VIEWS_WOW_LIT)
    if not subs_lit and not views_lit:
        return None
    if not evidence:
        return None
    confidence = "high" if mc.get("top1_share_high") else "medium"
    return Hypothesis(key="member_centric_spike", confidence=confidence, evidence=evidence)


def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    """시그널 dict → 점등된 가설 리스트. 점등 안 된 가설은 omit.

    dampen 정책 (spec rev 2 §3.3):
      - comeback_cycle 점등 → paid_youtube_ads / subscriber_purchase 감점.
      - member_centric_spike 점등 → paid_youtube_ads / subscriber_purchase 감점.
      - 둘 다 점등돼도 *한 번만* 감점 (set-based reason 누적).
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

    reasons: set[str] = set()
    if any(h.key == "comeback_cycle" and h.confidence in ("high", "medium") for h in lit):
        reasons.add("comeback")
    if any(h.key == "member_centric_spike" and h.confidence in ("high", "medium") for h in lit):
        reasons.add("member_centric")
    lit = _apply_dampen(
        lit,
        targets={"paid_youtube_ads", "subscriber_purchase"},
        reasons=reasons,
    )
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
        # 0048 schema 컬럼은 program / episode_date. signals 모듈 함수가
        # show / win_date dict key 를 expect 하므로 AS alias 로 호환.
        # status='confirmed' 만 카운트 (pending/rejected 제외 — 0048 설계).
        "SELECT group_key, program AS show, song_title, episode_date AS win_date "
        "FROM music_show_wins_log "
        "WHERE episode_date BETWEEN ? AND ? AND status = 'confirmed'",
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
    # rev 3 — 그룹 카테고리 메타 (kpop vs subculture).
    groups_meta_rows = db.execute(
        "SELECT key AS group_key, group_model FROM groups WHERE is_active = 1",
        [],
    )
    category_by_group: dict[str, str] = {
        r["group_key"]: _S._category_of(r.get("group_model"))
        for r in groups_meta_rows
        if r.get("group_key")
    }
    # rev 3 — 그룹별 weekly snapshot history (직전 8주). week_start 이전 기간의
    # 모든 그룹 행을 한 번에 가져온 뒤 group_key 별로 last-snap-per-week 처리.
    history_limit_days = max(_S.TEMPORAL_HISTORY_WEEKS * 7 * max(len(category_by_group), 1), 70)
    history_rows = db.execute(
        "SELECT group_key, snapshot_at, "
        "       yt_subscribers, yt_total_views, naver_total_news, "
        "       COALESCE(dc_total_posts,0) AS dc_total_posts, "
        "       COALESCE(theqoo_posts,0) AS theqoo_posts, "
        "       COALESCE(instiz_posts,0) AS instiz_posts "
        "FROM agg_summary "
        "WHERE substr(snapshot_at, 1, 10) < ? "
        "ORDER BY snapshot_at DESC LIMIT ?",
        [week_start, history_limit_days],
    )
    # V1 stub 활성화 (2026-05-26) — market_share_z. agg_market_share 의 해당 주
    # final score 를 category cohort 로 z 계산. organic_growth 의 5번째 lit
    # signal 활성화. week_start 와 같은 week_start row 가 없는 경우 (수요일
    # 실행 등) 가장 가까운 직전 week 의 row 사용.
    market_share_rows = db.execute(
        "SELECT group_key, final FROM agg_market_share "
        "WHERE week_start = ("
        "  SELECT MAX(week_start) FROM agg_market_share WHERE week_start <= ?"
        ")",
        [week_end],
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

    # 그룹별 history rows. 한 그룹당 최근 TEMPORAL_HISTORY_WEEKS 개 snapshot 만.
    history_by_group: dict[str, list[dict]] = {}
    for r in history_rows:
        gk = r.get("group_key")
        if gk is None:
            continue
        bucket = history_by_group.setdefault(gk, [])
        if len(bucket) < _S.TEMPORAL_HISTORY_WEEKS:
            bucket.append(r)

    def _comm_sum(r: dict) -> float:
        return float(
            (r.get("dc_total_posts") or 0)
            + (r.get("theqoo_posts") or 0)
            + (r.get("instiz_posts") or 0)
        )

    # 카테고리별 cohort lists (z-score 분모). N < CATEGORY_COHORT_MIN 이면 빈 리스트
    # → cohort_z_score 가 0 반환 → category_z=0 fallback.
    now_rows = list(now_by.values())

    def _cohort_for(gk: str, key: str) -> list[float]:
        cat = category_by_group.get(gk, "kpop")
        members = [
            r for r in now_rows
            if category_by_group.get(r.get("group_key", "")) == cat
        ]
        if len(members) < _S.CATEGORY_COHORT_MIN:
            return []
        if key == "_community":
            return [_comm_sum(r) for r in members]
        return [float(r.get(key) or 0) for r in members]

    # controversy 시그널은 rev 3 변경 대상 아님 — 기존 cross-sectional cohort 유지.
    controversy_count_cohort = [float(r.get("controversy_count") or 0) for r in now_rows]
    negative_ratio_cohort    = [float(r.get("negative_ratio")   or 0) for r in now_rows]

    # market_share final → group_key → float. now_rows 의 group 만 포함.
    market_share_by: dict[str, float] = {
        r["group_key"]: float(r.get("final") or 0.0)
        for r in market_share_rows
        if r.get("group_key")
    }

    def _market_share_z(gk: str) -> float:
        if gk not in market_share_by:
            return 0.0
        cat = category_by_group.get(gk, "kpop")
        cohort = [
            v for k, v in market_share_by.items()
            if category_by_group.get(k) == cat
        ]
        if len(cohort) < _S.CATEGORY_COHORT_MIN:
            return 0.0
        return _S.cohort_z_score(market_share_by[gk], cohort)
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

    # V1 stub 활성화 (2026-05-26) — 전주 시점의 category cohort z.
    # broadcast_appearance / community_word_of_mouth 의 lag 패턴 (전주 spike +
    # 이번 주 후행) 활성화. prev_by 의 same-category cohort 로 계산.
    prev_rows = list(prev_by.values())

    def _prev_cohort_for(gk: str, key: str) -> list[float]:
        cat = category_by_group.get(gk, "kpop")
        members = [
            r for r in prev_rows
            if category_by_group.get(r.get("group_key", "")) == cat
        ]
        if len(members) < _S.CATEGORY_COHORT_MIN:
            return []
        if key == "_community":
            return [_comm_sum(r) for r in members]
        return [float(r.get(key) or 0) for r in members]

    def _prev_z(gk: str, key: str, *, comm: bool = False) -> float:
        prev = prev_by.get(gk)
        if prev is None:
            return 0.0
        if comm:
            prev_val = _comm_sum(prev)
            cohort_vals = _prev_cohort_for(gk, "_community")
        else:
            prev_val = float(prev.get(key) or 0)
            cohort_vals = _prev_cohort_for(gk, key)
        return _S.cohort_z_score(prev_val, cohort_vals)

    def _axis(
        gk: str, key: str, *, comm: bool = False,
    ) -> dict:
        """rev 3 — 3-축 (category_z, temporal_z, wow_pct) 시그널 dict 빌더."""
        now = now_by[gk]
        prev = prev_by.get(gk, {})
        history = history_by_group.get(gk, [])
        if comm:
            now_val = _comm_sum(now)
            prev_val = _comm_sum(prev) if prev else 0.0
            history_vals = [_comm_sum(h) for h in history]
            cohort_vals = _cohort_for(gk, "_community")
        else:
            now_val = float(now.get(key) or 0)
            prev_val = float(prev.get(key) or 0) if prev else 0.0
            history_vals = [float(h.get(key) or 0) for h in history]
            cohort_vals = _cohort_for(gk, key)
        return {
            "category_z": _S.cohort_z_score(now_val, cohort_vals),
            "temporal_z": _S.temporal_z_score(now_val, history_vals),
            "wow_pct":    _S.wow_pct(now_val, prev_val if prev else None),
        }

    out: dict[str, GroupSignals] = {}
    for gk, now in now_by.items():
        prev = prev_by.get(gk, {})
        # member_pop now/prev 최신/이전 한 쌍
        mp_rows = sorted(member_pop_by.get(gk, []), key=lambda r: r.get("snapshot_at") or "")
        mp_now  = mp_rows[-1] if mp_rows else {}
        mp_prev = mp_rows[-2] if len(mp_rows) >= 2 else {}

        sig = {
            "subs":      _axis(gk, "yt_subscribers"),
            "views":     _axis(gk, "yt_total_views"),
            "news":      _axis(gk, "naver_total_news"),
            "community": _axis(gk, "_community", comm=True),
            "market_share_z":     _market_share_z(gk),
            "er_wow":             _S.engagement_rate_wow_drop(now, prev),
            "vps_wow":            _S.views_per_sub_wow_drop(now, prev),
            "organicity_paid":    _S.organicity_paid_ratio(organicity_by.get(gk, [])),
            "reactivity_dominant": _S.reactivity_dominant_platform(now),
            "member_centric":     _S.member_centric_signals(mp_now, mp_prev),
            "comeback": {
                "event_match":     _S.group_event_within_window(
                    events_by.get(gk, []), week_start=week_start, week_end=week_end,
                ),
                "music_streak":
                    _S.music_show_consecutive_wins(music_show_by.get(gk, []))["consecutive"],
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
            "news_z_prev_week":           _prev_z(gk, "naver_total_news"),
            "community_z_prev_week":      _prev_z(gk, "_community", comm=True),
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

        deltas: dict[str, float] = {
            "subs_z":   sig["subs"]["category_z"],
            "views_z":  sig["views"]["category_z"],
            "news_z":   sig["news"]["category_z"],
            "subs_temporal_z":   sig["subs"]["temporal_z"],
            "views_temporal_z":  sig["views"]["temporal_z"],
            "subs_wow":   sig["subs"]["wow_pct"] if sig["subs"]["wow_pct"] is not None else 0.0,
            "views_wow":  sig["views"]["wow_pct"] if sig["views"]["wow_pct"] is not None else 0.0,
        }
        if sig["er_wow"] is not None:
            deltas["er_wow"] = sig["er_wow"]

        out[gk] = GroupSignals(
            group_key=gk,
            hypotheses=hyps,
            meta_guards=guards,
            deltas=deltas,
            organicity={
                "paid_ratio": sig["organicity_paid"],
            } if sig["organicity_paid"] is not None else None,
        )
    return out


def _shift_iso_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()
