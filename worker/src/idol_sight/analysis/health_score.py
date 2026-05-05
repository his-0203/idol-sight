"""Health Score (spec §7.1).

Pure function — input dict, output HealthScore. The computation is
intentionally small and centralised here so the frontend can request the
same weights via /api/health/spec.

REF values used to be hard-coded (subs=1M, views=200M, quality=10M,
community=200K, news=500). That made PLAVE saturate at 1.0 across all
five dimensions while every other group landed at 0.05–0.3 — the BI lost
discrimination power for the bottom seven groups. We now compute REF
dynamically from the cohort's p90 (the 90th-percentile value across all
active groups in the same snapshot), so the scale stretches naturally
as the market grows. ``compute_dynamic_refs`` returns the REFs and
``compute_health_score`` accepts a ``refs`` dict to use instead of the
fallback constants.

Quality is now an engagement-rate signal: (likes + 5·comments) / views
across recent videos. The old "top10 average views" was really a
viewership measure (correlates with channel size), not quality. The
dataclass still exposes ``quality_method`` so the API can advertise
which formula produced the number.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

WEIGHTS: dict[str, int] = {
    "subscribers": 20,
    "views":       20,
    "quality":     15,
    "community":   20,
    "news":        10,
    "risk":        15,
}
BONUS_MAX = 10                # recent_90d (≤7) + recent_30d (≤3)
DENOM = sum(WEIGHTS.values()) + BONUS_MAX  # = 110

# Fallback REF values used when no cohort data is supplied (e.g. unit tests
# or first-ever run with one group). Kept conservative — calibrated against
# 2026-01 K-pop tier-2/3 mid-points so PLAVE doesn't saturate against them.
DEFAULT_REFS: dict[str, float] = {
    "subscribers": 1_000_000,
    "views":       200_000_000,
    "quality":     0.05,        # 5% engagement rate ≈ very high
    "community":   200_000,
    "news":        500,
}

# When computing dynamic refs we use p90 (90th percentile) of the cohort.
# 1.0 then means "this group sits at the top decile of the market", which
# is the right semantic for an idol BI: top tier = saturated, mid tier =
# half-filled, debut tier = small but visible.
DYNAMIC_REF_PERCENTILE = 0.90
# Floor each dynamic REF so a one-group cohort or all-zero column doesn't
# collapse to 0 (which would divide-by-zero through _normalize). The floor
# values are intentionally small — they only kick in for empty markets.
MIN_REFS: dict[str, float] = {
    "subscribers": 50_000,
    "views":       1_000_000,
    "quality":     0.005,
    "community":   1_000,
    "news":        10,
}

GRADE_THRESHOLDS = [
    (9.0, "S"),
    (7.0, "A"),
    (5.0, "B"),
    (3.0, "C"),
    (0.0, "D"),
]
GRADE_LABELS = {
    "S": "정상 궤도",  "A": "안정적",  "B": "성장 중",
    "C": "초기 진입",  "D": "활동 미미",  "PRE": "데뷔 전 (활동량 부족)",
}


@dataclass
class HealthScore:
    total: float | None
    raw_total: float | None
    grade: str
    label: str
    breakdown: dict[str, float] = field(default_factory=dict)
    bonus: dict[str, float] = field(default_factory=dict)
    quality_method: str = "n/a"


def _is_pre_debut(debut_date: str | None) -> bool:
    if not debut_date:
        return True
    try:
        d = date.fromisoformat(debut_date)
    except ValueError:
        return True
    return d > date.today()


def _normalize(value: float, ref: float) -> float:
    """Clamp value/ref to [0, 1]."""
    if ref <= 0:
        return 0.0
    return min(max(value / ref, 0.0), 1.0)


def _percentile(values: list[float], pct: float) -> float:
    """Linear-interpolated percentile (numpy-free).

    Returns 0.0 for empty input. ``pct`` is in [0, 1]. Used to derive
    cohort-relative REF values for the Health Score normalizer.
    """
    if not values:
        return 0.0
    s = sorted(v for v in values if v is not None)
    if not s:
        return 0.0
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    frac = k - lo
    return float(s[lo] + (s[hi] - s[lo]) * frac)


def compute_dynamic_refs(cohort: list[dict[str, Any]]) -> dict[str, float]:
    """Derive per-dimension REF values from cohort p90.

    ``cohort`` is the list of agg dicts (one per active group, same
    snapshot) that's about to feed into ``compute_health_score``. We
    compute each REF as max(p90 of cohort, MIN_REFS[dim]) so that:

    - top tier (≥p90) → normalized to 1.0
    - mid tier         → ~0.5
    - debut tier       → small but non-saturated

    All five normalized inputs (sub/view/quality/community/news) are
    derived this way; risk/bonus stay model-fixed.
    """
    refs: dict[str, float] = {}
    sub_vals = [float(g.get("yt_subscribers", 0) or 0) for g in cohort]
    view_vals = [float(g.get("yt_total_views", 0) or 0) for g in cohort]
    qual_vals = [float(_engagement_rate(g)) for g in cohort]
    comm_vals = [
        float((g.get("dc_total_posts", 0) or 0)
              + (g.get("theqoo_posts", 0) or 0)
              + (g.get("instiz_posts", 0) or 0))
        for g in cohort
    ]
    news_vals = [float(g.get("naver_total_news", 0) or 0) for g in cohort]

    refs["subscribers"] = max(_percentile(sub_vals, DYNAMIC_REF_PERCENTILE),
                              MIN_REFS["subscribers"])
    refs["views"] = max(_percentile(view_vals, DYNAMIC_REF_PERCENTILE),
                        MIN_REFS["views"])
    refs["quality"] = max(_percentile(qual_vals, DYNAMIC_REF_PERCENTILE),
                          MIN_REFS["quality"])
    refs["community"] = max(_percentile(comm_vals, DYNAMIC_REF_PERCENTILE),
                            MIN_REFS["community"])
    refs["news"] = max(_percentile(news_vals, DYNAMIC_REF_PERCENTILE),
                       MIN_REFS["news"])
    return refs


def _engagement_rate(agg: dict[str, Any]) -> float:
    """(likes + 5·comments) / views across the group's recent videos.

    Comments weighted 5× because they require strictly more effort than
    a like, so they're a stronger fandom signal. Returns 0.0 when views
    are missing — a safer default than dividing by something tiny.
    """
    likes = int(agg.get("likes_total", 0) or 0)
    comments = int(agg.get("comments_total", 0) or 0)
    views = int(agg.get("yt_total_views", 0) or 0)
    if views <= 0:
        return 0.0
    return (likes + 5 * comments) / views


def _quality_score_from_engagement(rate: float, ref: float) -> float:
    """Engagement rate clamped to [0, 1] against the cohort REF."""
    return _normalize(rate, ref)


def _controversy_factor(count: int) -> float:
    """Return a 0-1 factor where 1.0 = no controversy and 0 = many."""
    if count <= 0:
        return 1.0
    return max(0.0, 1.0 - (count / 10.0))


def _recent_bonus(v90: int, v30: int) -> tuple[float, dict]:
    b90 = min(v90 / 30.0, 1.0) * 7.0   # up to 7
    b30 = min(v30 / 10.0, 1.0) * 3.0   # up to 3
    return b90 + b30, {"recent_90d": round(b90, 2), "recent_30d": round(b30, 2),
                       "v90_cnt": v90, "v30_cnt": v30}


def compute_health_score(
    group_key: str,
    agg: dict[str, Any],
    debut_date: str | None,
    *,
    refs: dict[str, float] | None = None,
) -> HealthScore:
    if _is_pre_debut(debut_date):
        return HealthScore(
            total=None, raw_total=None,
            grade="PRE", label=GRADE_LABELS["PRE"],
        )

    r = {**DEFAULT_REFS, **(refs or {})}

    sub_score = (
        _normalize(agg.get("yt_subscribers", 0), r["subscribers"])
        * WEIGHTS["subscribers"]
    )
    view_score = (
        _normalize(agg.get("yt_total_views", 0), r["views"]) * WEIGHTS["views"]
    )
    eng_rate = _engagement_rate(agg)
    qual_score = (
        _quality_score_from_engagement(eng_rate, r["quality"])
        * WEIGHTS["quality"]
    )
    comm_total = (agg.get("dc_total_posts", 0)
                  + agg.get("theqoo_posts", 0)
                  + agg.get("instiz_posts", 0))
    comm_score = _normalize(comm_total, r["community"]) * WEIGHTS["community"]
    news_score = (
        _normalize(agg.get("naver_total_news", 0), r["news"]) * WEIGHTS["news"]
    )
    risk_score = (
        _controversy_factor(agg.get("controversy_count", 0)) * WEIGHTS["risk"]
    )

    base = sub_score + view_score + qual_score + comm_score + news_score + risk_score
    bonus_total, bonus_dict = _recent_bonus(
        agg.get("v90_count", 0), agg.get("v30_count", 0),
    )

    raw_total = base + bonus_total
    total = round(raw_total / DENOM * 10.0, 1)
    grade = next(g for thr, g in GRADE_THRESHOLDS if total >= thr)

    return HealthScore(
        total=total, raw_total=round(raw_total, 2),
        grade=grade, label=GRADE_LABELS[grade],
        breakdown={
            "subscribers": round(sub_score, 2),
            "views":       round(view_score, 2),
            "quality":     round(qual_score, 2),
            "community":   round(comm_score, 2),
            "news":        round(news_score, 2),
            "risk":        round(risk_score, 2),
        },
        bonus=bonus_dict,
        quality_method=("engagement_rate" if eng_rate > 0 else "engagement_rate_zero"),
    )
