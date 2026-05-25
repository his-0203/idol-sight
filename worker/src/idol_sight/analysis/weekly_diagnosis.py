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
    er_wow = sig.get("er_wow") or 0.0   # None → 0.0 (변화 없음으로 처리)
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
    # ER 안정성 (절대값 < 0.15) — 광고 의심 가설을 깎아냄
    if abs(er_wow) >= 0.15:
        return None    # ER 불안정 시 organic 가설 제외
    if len(lit_signals) < 4:
        return None
    confidence = "high" if len(lit_signals) >= 4 else "medium"
    return Hypothesis(key="organic_growth", confidence=confidence, evidence=lit_signals)


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
