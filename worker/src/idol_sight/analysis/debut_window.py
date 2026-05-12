"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos uploaded in the ±60 day window around each group's debut date.

See docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md for
the algorithm rationale, signal weights, and verdict thresholds.
"""

from __future__ import annotations

# (label, days_lo_inclusive, days_hi_inclusive). Ranges are non-overlapping
# and contiguous from -60 (60 days before debut) to +60.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60",  -60, -31),
    ("D-30",  -30,  -2),
    ("D-Day",  -1,   1),
    ("D+30",   2,  30),
    ("D+60",  31,  60),
]


def bucket_for(days_relative: int) -> str | None:
    """Map a signed day offset to its bucket label, or None if out of window.

    ``days_relative`` is days from debut: negative = before, positive = after.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    return None


def compute_engagement_score(engagement_rate: float, is_short: bool) -> int:
    """0-100 score from engagement_rate. Shorts baseline lower than long-form."""
    if is_short:
        floor, ceil = 0.003, 0.033
    else:
        floor, ceil = 0.005, 0.055
    span = ceil - floor
    raw = (engagement_rate - floor) / span * 100.0
    return max(0, min(100, round(raw)))


def compute_balance_score(like_comment_ratio: float) -> int:
    """0-100 score. Normal K-pop ratio is 15-80; outside penalizes farms."""
    r = like_comment_ratio
    if 15.0 <= r <= 80.0:
        return 100
    if r < 15.0:
        return max(0, round(100 - (15.0 - r) * 8))
    # r > 80
    return max(0, round(100 - (r - 80.0) / 5.0))


def compute_velocity_coherence(
    velocity_ratio: float | None,
    engagement_rate: float,
) -> int:
    """Cross-check: high velocity should bring proportional engagement.

    velocity_ratio < 1.5 → neutral 50 (no virality to assess).
    velocity_ratio ≥ 1.5 + ER ≥ 3% → 100 (real viral).
    velocity_ratio ≥ 1.5 + ER ≥ 1.5% → 60 (weak suspicion).
    velocity_ratio ≥ 1.5 + ER < 1.5% → 20 (paid burst).
    """
    if velocity_ratio is None or velocity_ratio < 1.5:
        return 50
    if engagement_rate >= 0.03:
        return 100
    if engagement_rate >= 0.015:
        return 60
    return 20


WEIGHTS = {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}


def classify_verdict(score: int) -> str:
    if score >= 70:
        return "organic"
    if score >= 40:
        return "suspect"
    return "likely_paid"


def compute_organic_score(video: dict) -> tuple[int | None, dict]:
    """Compute composite 0-100 score + signal breakdown for one video.

    Returns (None, breakdown_with_verdict='insufficient_data') when sample
    is too small to trust (view_count < 1000 AND engagement total < 10).
    """
    view_count = video.get("view_count") or 0
    like_count = video.get("like_count") or 0
    comment_count = video.get("comment_count") or 0
    is_short = bool(video.get("is_short"))
    velocity_ratio = video.get("viral_velocity_ratio")

    engagement_total = like_count + comment_count
    if view_count < 1000 and engagement_total < 10:
        return None, {
            "view_count": view_count,
            "engagement_total": engagement_total,
            "verdict": "insufficient_data",
        }

    safe_views = max(view_count, 1)
    safe_comments = max(comment_count, 1)
    engagement_rate = engagement_total / safe_views
    like_comment_ratio = like_count / safe_comments

    e_score = compute_engagement_score(engagement_rate, is_short)
    b_score = compute_balance_score(like_comment_ratio)
    v_score = compute_velocity_coherence(velocity_ratio, engagement_rate)

    composite = round(
        WEIGHTS["engagement"] * e_score
        + WEIGHTS["balance"]    * b_score
        + WEIGHTS["velocity"]   * v_score
    )
    verdict = classify_verdict(composite)

    breakdown = {
        "engagement_rate": round(engagement_rate, 4),
        "engagement_score": e_score,
        "like_comment_ratio": round(like_comment_ratio, 2),
        "balance_score": b_score,
        "velocity_ratio": velocity_ratio,
        "velocity_coherence_score": v_score,
        "weights": WEIGHTS,
        "verdict": verdict,
    }
    return composite, breakdown
