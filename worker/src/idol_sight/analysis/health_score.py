"""Health Score (spec §7.1).

Pure function — input dict, output HealthScore. The computation is
intentionally small and centralised here so the frontend can request the
same weights via /api/health/spec.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
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


def _quality_score(top10: list[dict]) -> float:
    if not top10:
        return 0.0
    avg = sum(int(v.get("views", 0) or 0) for v in top10) / len(top10)
    # 1.0 maps to ~10M average views.
    return min(avg / 10_000_000, 1.0)


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
) -> HealthScore:
    if _is_pre_debut(debut_date):
        return HealthScore(
            total=None, raw_total=None,
            grade="PRE", label=GRADE_LABELS["PRE"],
        )

    sub_score  = _normalize(agg.get("yt_subscribers", 0), 1_000_000)   * WEIGHTS["subscribers"]
    view_score = _normalize(agg.get("yt_total_views", 0), 200_000_000) * WEIGHTS["views"]
    qual_score = _quality_score(agg.get("yt_top10") or [])             * WEIGHTS["quality"]
    comm_total = (agg.get("dc_total_posts", 0)
                  + agg.get("theqoo_posts", 0)
                  + agg.get("instiz_posts", 0))
    comm_score = _normalize(comm_total, 200_000)                       * WEIGHTS["community"]
    news_score = _normalize(agg.get("naver_total_news", 0), 500)       * WEIGHTS["news"]
    risk_score = _controversy_factor(agg.get("controversy_count", 0))  * WEIGHTS["risk"]

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
        quality_method="top10_avg",
    )
