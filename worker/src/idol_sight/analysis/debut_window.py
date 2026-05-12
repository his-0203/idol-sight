"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos uploaded in the ±60 day window around each group's debut date.

See docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md for
the algorithm rationale, signal weights, and verdict thresholds.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Mapping, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "WINDOW_BUCKETS",
    "WEIGHTS",
    "bucket_for",
    "compute_organic_score",
    "build_video_organicity",
]

# (label, days_lo_inclusive, days_hi_inclusive). Ranges are non-overlapping
# and contiguous from -60 (60 days before debut) to +60.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60",  -60, -31),
    ("D-30",  -30,  -2),
    ("D-Day",  -1,   1),
    ("D+30",   2,  30),
    ("D+60",  31,  60),
]

# Engagement-rate boundaries (per-bucket scoring). Below floor = 0pt,
# above ceiling = 100pt, linear interpolation between.
LONG_ER_FLOOR, LONG_ER_CEIL = 0.005, 0.055
SHORT_ER_FLOOR, SHORT_ER_CEIL = 0.003, 0.033

# Like:comment ratio normal zone for K-pop videos. Outside zone penalizes
# asymmetric bot activity (comment-farm below, like-farm above).
BALANCE_NORMAL_LO, BALANCE_NORMAL_HI = 15.0, 80.0
BALANCE_LOW_PENALTY_PER_UNIT = 8.0       # ratio<15 → comment-farm slope
BALANCE_HIGH_PENALTY_DIVISOR = 5.0       # ratio>80 → like-farm (0.2/unit)

# Velocity-engagement coherence cross-check.
VIRAL_VELOCITY_THRESHOLD = 1.5           # below = neutral (50pt)
VIRAL_ER_REAL = 0.03                     # ER above this with viral velocity = real
VIRAL_ER_WEAK = 0.015                    # ER above this = weak suspicion

_WEIGHTS_RAW = {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}
WEIGHTS: Mapping[str, float] = MappingProxyType(_WEIGHTS_RAW)


def bucket_for(days_relative: int) -> str | None:
    """Map a signed day offset to its bucket label, or None if out of window.

    ``days_relative`` is days from debut: negative = before, positive = after.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    return None


def _compute_engagement_score(engagement_rate: float, is_short: bool) -> int:
    """0-100 score from engagement_rate. Shorts baseline lower than long-form."""
    if is_short:
        floor, ceil = SHORT_ER_FLOOR, SHORT_ER_CEIL
    else:
        floor, ceil = LONG_ER_FLOOR, LONG_ER_CEIL
    span = ceil - floor
    raw = (engagement_rate - floor) / span * 100.0
    return max(0, min(100, round(raw)))


def _compute_balance_score(like_comment_ratio: float) -> int:
    """0-100 score. Normal K-pop ratio is 15-80; outside penalizes farms."""
    r = like_comment_ratio
    if BALANCE_NORMAL_LO <= r <= BALANCE_NORMAL_HI:
        return 100
    if r < BALANCE_NORMAL_LO:
        return max(0, round(100 - (BALANCE_NORMAL_LO - r) * BALANCE_LOW_PENALTY_PER_UNIT))
    # r > BALANCE_NORMAL_HI
    return max(0, round(100 - (r - BALANCE_NORMAL_HI) / BALANCE_HIGH_PENALTY_DIVISOR))


def _compute_velocity_coherence(
    velocity_ratio: float | None,
    engagement_rate: float,
) -> int:
    """Cross-check: high velocity should bring proportional engagement.

    velocity_ratio < 1.5 → neutral 50 (no virality to assess).
    velocity_ratio ≥ 1.5 + ER ≥ 3% → 100 (real viral).
    velocity_ratio ≥ 1.5 + ER ≥ 1.5% → 60 (weak suspicion).
    velocity_ratio ≥ 1.5 + ER < 1.5% → 20 (paid burst).
    """
    if velocity_ratio is None or velocity_ratio < VIRAL_VELOCITY_THRESHOLD:
        return 50
    if engagement_rate >= VIRAL_ER_REAL:
        return 100
    if engagement_rate >= VIRAL_ER_WEAK:
        return 60
    return 20


def _classify_verdict(score: int) -> str:
    if score >= 70:
        return "organic"
    if score >= 40:
        return "suspect"
    return "likely_paid"


def compute_organic_score(video: dict) -> tuple[int | None, dict]:
    """Compute composite 0-100 score + signal breakdown for one video.

    Returns (None, breakdown_with_verdict='insufficient_data') when sample
    is too small to trust (view_count < 1000 AND engagement_total < 10).

    Edge case — 0 comments: like_comment_ratio is computed as likes/1, which
    produces a high ratio (large like_count, denom=1). This treats like-only
    engagement as a like-farm signal (intentional — videos with zero
    discussion but heavy likes match the like-farm pattern we want to flag).
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

    e_score = _compute_engagement_score(engagement_rate, is_short)
    b_score = _compute_balance_score(like_comment_ratio)
    v_score = _compute_velocity_coherence(velocity_ratio, engagement_rate)

    composite = round(
        WEIGHTS["engagement"] * e_score
        + WEIGHTS["balance"]    * b_score
        + WEIGHTS["velocity"]   * v_score
    )
    verdict = _classify_verdict(composite)

    breakdown = {
        "engagement_rate": round(engagement_rate, 4),
        "engagement_score": e_score,
        "like_comment_ratio": round(like_comment_ratio, 2),
        "balance_score": b_score,
        "velocity_ratio": velocity_ratio,
        "velocity_coherence_score": v_score,
        "weights": dict(WEIGHTS),
        "verdict": verdict,
    }
    return composite, breakdown


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_FETCH_VIDEOS_SQL = """
SELECT v.video_id, v.group_key, v.is_short, v.published_at,
       v.viral_velocity_ratio,
       g.debut_date,
       s.view_count, s.like_count, s.comment_count
FROM youtube_videos v
JOIN groups g ON g.key = v.group_key
LEFT JOIN youtube_video_stats s
       ON s.video_id = v.video_id
      AND s.snapshot_at = (
            SELECT MAX(snapshot_at) FROM youtube_video_stats s2
             WHERE s2.video_id = v.video_id
          )
WHERE g.debut_date IS NOT NULL
  AND v.published_at IS NOT NULL
  AND julianday(v.published_at)
        BETWEEN julianday(g.debut_date) - 60
            AND julianday(g.debut_date) + 60
"""


_UPSERT_VIDEO_SQL = """
INSERT INTO debut_window_video_organicity
  (video_id, group_key, is_short, published_at,
   days_relative_to_debut, window_bucket,
   view_count, like_count, comment_count,
   engagement_rate, like_comment_ratio, velocity_ratio,
   organic_score, verdict, signal_breakdown, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(video_id) DO UPDATE SET
  group_key=excluded.group_key,
  is_short=excluded.is_short,
  published_at=excluded.published_at,
  days_relative_to_debut=excluded.days_relative_to_debut,
  window_bucket=excluded.window_bucket,
  view_count=excluded.view_count,
  like_count=excluded.like_count,
  comment_count=excluded.comment_count,
  engagement_rate=excluded.engagement_rate,
  like_comment_ratio=excluded.like_comment_ratio,
  velocity_ratio=excluded.velocity_ratio,
  organic_score=excluded.organic_score,
  verdict=excluded.verdict,
  signal_breakdown=excluded.signal_breakdown,
  computed_at=excluded.computed_at
"""


def _days_between(debut_date: str, published_at: str) -> int:
    """Return days_relative_to_debut. published_at is ISO8601 timestamp,
    debut_date is YYYY-MM-DD. Negative = before debut."""
    d_debut = datetime.fromisoformat(debut_date).date()
    d_pub = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
    return (d_pub - d_debut).days


def build_video_organicity(client: _Executor) -> CollectionResult:
    """Score every video in each group's ±60d debut window, return upsert
    statements. Idempotent on video_id."""
    rows = client.execute(_FETCH_VIDEOS_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list[Any]]] = []

    for r in rows:
        days_rel = _days_between(r["debut_date"], r["published_at"])
        bucket = bucket_for(days_rel)
        if bucket is None:
            continue  # outside window; defensive (SQL already filtered)

        video = {
            "is_short": r.get("is_short") or 0,
            "view_count": r.get("view_count") or 0,
            "like_count": r.get("like_count") or 0,
            "comment_count": r.get("comment_count") or 0,
            "viral_velocity_ratio": r.get("viral_velocity_ratio"),
        }
        score, breakdown = compute_organic_score(video)
        verdict = breakdown["verdict"]
        view_count = video["view_count"]
        like_count = video["like_count"]
        comment_count = video["comment_count"]
        if score is None:
            engagement_rate = None
            like_comment_ratio = None
        else:
            engagement_rate = breakdown["engagement_rate"]
            like_comment_ratio = breakdown["like_comment_ratio"]

        statements.append((_UPSERT_VIDEO_SQL, [
            r["video_id"], r["group_key"], video["is_short"],
            r["published_at"], days_rel, bucket,
            view_count, like_count, comment_count,
            engagement_rate, like_comment_ratio, video["viral_velocity_ratio"],
            score, verdict, json.dumps(breakdown), now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
