"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos. V3.1 (2026-05-25): scoring applies to all videos for groups with a
debut_date; Pre/Post buckets catch videos outside the ±60d window so the
[전체 기간] view in DebutWindowVideoTable can render ER/Score/판정 for
every video instead of 91% NULL.

See docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md for
the algorithm rationale, signal weights, and verdict thresholds, and
docs/superpowers/specs/2026-05-25-organicity-all-videos-design.md for the
V3.1 all-videos amendment.
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "WINDOW_BUCKETS",
    "WEIGHTS",
    "VERDICT_TIERS",
    "bucket_for",
    "compute_organic_score",
    "build_video_organicity",
    "build_summary",
]

# (label, days_lo_inclusive, days_hi_inclusive). V2.34 (2026-05-27):
# 균등 20일 폭 통일. 이전엔 D-60/D+60 (30일), D-30~D+30 (10일), D-Day
# (3일) 로 폭 비대칭이라 그룹 간 점수 비교 시 표본 수 격차 (D-60 30일
# 영상 vs D-30 10일 영상) 가 발생, 또한 ±30 안쪽의 D-20/D-10/D+10/D+20
# 가 KPI / Posture bar / DebutWindowVideoTable 5탭 UI 에 비노출 → 데뷔
# windowing 의 연속 비교가 불가했음.
#
# 신규 정의: 7 named bucket 모두 정확히 20일 폭. D-Day 는 데뷔일 중심
# ±10일(−10..+9) 으로 "데뷔 직전·직후 1주반" 의미 보존. 라벨 N 은 N일
# 부근 ±10 범위. Pre/Post 는 ±69일 밖 catch-all (전체 기간 view 에서만
# 가시).
#
# Pre/Post 라벨은 frontend 의 DebutWindowKPI / CompetitorOrganicityBar /
# DebutWindowVideoTable 의 7 탭 UI 에 *포함되지 않음* — 자동 무시.
# DebutWindowVideoTable 의 [전체 기간] view 만 모든 bucket 영상 표시.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("Pre",   -999999, -71),
    ("D-60",     -70,  -51),
    ("D-40",     -50,  -31),
    ("D-20",     -30,  -11),
    ("D-Day",    -10,    9),
    ("D+20",      10,   29),
    ("D+40",      30,   49),
    ("D+60",      50,   69),
    ("Post",      70, 999999),
]

# Engagement-rate boundaries (V2 calibrated 2026-05-13 from 1125-video remote
# D1 distribution: long p10=1.57% p90=6.69%, shorts p10≈2.0% p90=8.19%).
# Below floor = 0pt, above ceiling = 100pt, linear interpolation between.
LONG_ER_FLOOR, LONG_ER_CEIL = 0.010, 0.060
SHORT_ER_FLOOR, SHORT_ER_CEIL = 0.015, 0.080

# Shorts scale gate (V2.36 2026-06-05). Below this absolute view volume a
# Short's organic/paid signal is unreliable and we hold it as insufficient_data
# rather than judge it. Two failure modes collapse an organic viral Short onto
# the same signature as a paid burst at low volume:
#   1. velocity_ratio is views-over-baseline, so a near-zero pre-debut channel
#      baseline makes it explode (the MiiWAN 꿍싯꿍싯 Short showed velocity 18.5
#      at only 38K views — a denominator artifact, not a bought spike), tripping
#      the paid_burst signal.
#   2. Shorts ER is structurally low (feed swipe-by views inflate the
#      denominator), so a genuinely organic clip lands below SHORT_ER_FLOOR and
#      zeroes the engagement signal.
# Asserting "likely_paid" on a sub-100K Short is not credible at K-pop/vtuber
# scale and risks a false accusation (ethics §7 / v2-roadmap: avoid false
# positives / Streisand). Competitor Shorts worth judging clear this easily;
# MiiWAN's own pre-debut Shorts fall below and read as 판정 보류 (the company
# knows its own ad spend, and the planned YouTube Analytics traffic-source
# integration gives ground truth there). First-pass value — recalibrate against
# the real Short view distribution.
SHORT_MIN_SCORABLE_VIEWS = 100_000

# Like:comment ratio normal zone — type-split (V2). Long-form K-pop ratios
# distribute much lower than shorts (long p90=27 vs shorts p90=94.2).
# Outside zone penalizes asymmetric bot activity (comment-farm below,
# like-farm above).
BALANCE_NORMAL_LONG_LO, BALANCE_NORMAL_LONG_HI = 10.0, 50.0
BALANCE_NORMAL_SHORT_LO, BALANCE_NORMAL_SHORT_HI = 20.0, 150.0
BALANCE_LONG_LOW_PENALTY_PER_UNIT = 8.0   # long ratio<10 → comment-farm slope
BALANCE_LONG_HIGH_PENALTY_PER_UNIT = 0.5  # long ratio>50 → like-farm slope
BALANCE_SHORT_LOW_PENALTY_PER_UNIT = 4.0  # short ratio<20 → comment-farm slope
BALANCE_SHORT_HIGH_PENALTY_PER_UNIT = 0.1 # short ratio>150 → like-farm slope

# Velocity-engagement coherence cross-check. NULL velocity is treated as a
# missing signal (weight redistributed) — V2 calibration discovered ~91%
# of videos have NULL viral_velocity_ratio so the V1 fixed-50 mid-point was
# masking real signal weight.
VIRAL_VELOCITY_THRESHOLD = 1.5           # below = neutral (50pt)
VIRAL_ER_REAL = 0.03                     # ER above this with viral velocity = real
VIRAL_ER_WEAK = 0.015                    # ER above this = weak suspicion

# When velocity is present, weights are 0.5/0.3/0.2. When velocity is NULL,
# the 0.2 share redistributes proportionally between engagement and balance
# (0.5/0.8 = 0.625, 0.3/0.8 = 0.375).
_WEIGHTS_RAW = {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}
_WEIGHTS_NO_VELOCITY_RAW = {"engagement": 0.625, "balance": 0.375}
WEIGHTS: Mapping[str, float] = MappingProxyType(_WEIGHTS_RAW)
WEIGHTS_NO_VELOCITY: Mapping[str, float] = MappingProxyType(_WEIGHTS_NO_VELOCITY_RAW)


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


def _compute_balance_score(like_comment_ratio: float, is_short: bool) -> int:
    """0-100 score. Type-split normal zones (V2 calibration):
    long-form 10-50, shorts 20-150. Outside zone penalizes farms."""
    r = like_comment_ratio
    if is_short:
        lo, hi = BALANCE_NORMAL_SHORT_LO, BALANCE_NORMAL_SHORT_HI
        low_slope = BALANCE_SHORT_LOW_PENALTY_PER_UNIT
        high_slope = BALANCE_SHORT_HIGH_PENALTY_PER_UNIT
    else:
        lo, hi = BALANCE_NORMAL_LONG_LO, BALANCE_NORMAL_LONG_HI
        low_slope = BALANCE_LONG_LOW_PENALTY_PER_UNIT
        high_slope = BALANCE_LONG_HIGH_PENALTY_PER_UNIT
    if lo <= r <= hi:
        return 100
    if r < lo:
        return max(0, round(100 - (lo - r) * low_slope))
    return max(0, round(100 - (r - hi) * high_slope))


def _compute_velocity_coherence(
    velocity_ratio: float | None,
    engagement_rate: float,
) -> int | None:
    """Cross-check: high velocity should bring proportional engagement.

    velocity_ratio is None → None (signal absent; weight redistributes).
    velocity_ratio < 1.5 → neutral 50 (no virality to assess).
    velocity_ratio ≥ 1.5 + ER ≥ 3% → 100 (real viral).
    velocity_ratio ≥ 1.5 + ER ≥ 1.5% → 60 (weak suspicion).
    velocity_ratio ≥ 1.5 + ER < 1.5% → 20 (paid burst).
    """
    if velocity_ratio is None:
        return None
    if velocity_ratio < VIRAL_VELOCITY_THRESHOLD:
        return 50
    if engagement_rate >= VIRAL_ER_REAL:
        return 100
    if engagement_rate >= VIRAL_ER_WEAK:
        return 60
    return 20


def _classify_verdict(score: int) -> str:
    """V2.21 5-tier verdict (was 3-tier 70/40 in V2.20)."""
    if score >= 85:
        return "organic_strong"
    if score >= 70:
        return "organic"
    if score >= 55:
        return "borderline"
    if score >= 40:
        return "suspect"
    return "likely_paid"


# V2.21 verdict tiers — order matters for any iteration that needs
# "from organic to paid". Keep in sync with _classify_verdict.
VERDICT_TIERS: tuple[str, ...] = (
    "organic_strong",
    "organic",
    "borderline",
    "suspect",
    "likely_paid",
)


def _compute_causes(
    e_score: int,
    b_score: int,
    v_score: int | None,
    like_comment_ratio: float,
    is_short: bool,
    verdict: str,
) -> list[str]:
    """Auto-tag signal-level causes for a video. viral_real is attached
    regardless of verdict (organic videos benefit from it too). Suspicion
    causes only attach when verdict is below organic — for organic_strong/
    organic, listing 'engagement_weak' would be self-contradictory."""
    causes: list[str] = []
    if v_score == 100:
        causes.append("viral_real")
    if verdict in ("borderline", "suspect", "likely_paid"):
        if e_score < 40:
            causes.append("engagement_weak")
        if b_score < 60:
            if is_short:
                lo, hi = BALANCE_NORMAL_SHORT_LO, BALANCE_NORMAL_SHORT_HI
            else:
                lo, hi = BALANCE_NORMAL_LONG_LO, BALANCE_NORMAL_LONG_HI
            if like_comment_ratio < lo:
                causes.append("comment_farm")
            elif like_comment_ratio > hi:
                causes.append("like_farm")
        if v_score is not None and v_score <= 20:
            causes.append("paid_burst")
    return causes


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
            "reason": "low_engagement",
        }

    # Shorts scale gate (V2.36) — see SHORT_MIN_SCORABLE_VIEWS. Below this view
    # volume the organic/paid signal is dominated by baseline artifacts; hold
    # rather than judge so an organic viral Short isn't accused of being paid.
    if is_short and view_count < SHORT_MIN_SCORABLE_VIEWS:
        return None, {
            "view_count": view_count,
            "engagement_total": engagement_total,
            "verdict": "insufficient_data",
            "reason": "low_volume_short",
        }

    safe_views = max(view_count, 1)
    safe_comments = max(comment_count, 1)
    engagement_rate = engagement_total / safe_views
    like_comment_ratio = like_count / safe_comments

    e_score = _compute_engagement_score(engagement_rate, is_short)
    b_score = _compute_balance_score(like_comment_ratio, is_short)
    v_score = _compute_velocity_coherence(velocity_ratio, engagement_rate)

    if v_score is None:
        composite = round(
            WEIGHTS_NO_VELOCITY["engagement"] * e_score
            + WEIGHTS_NO_VELOCITY["balance"]   * b_score
        )
        weights_used = dict(WEIGHTS_NO_VELOCITY)
    else:
        composite = round(
            WEIGHTS["engagement"] * e_score
            + WEIGHTS["balance"]    * b_score
            + WEIGHTS["velocity"]   * v_score
        )
        weights_used = dict(WEIGHTS)
    verdict = _classify_verdict(composite)
    causes = _compute_causes(
        e_score, b_score, v_score, like_comment_ratio, is_short, verdict,
    )

    breakdown = {
        "engagement_rate": round(engagement_rate, 4),
        "engagement_score": e_score,
        "like_comment_ratio": round(like_comment_ratio, 2),
        "balance_score": b_score,
        "velocity_ratio": velocity_ratio,
        "velocity_coherence_score": v_score,
        "weights": weights_used,
        "verdict": verdict,
        "causes": causes,
    }
    return composite, breakdown


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_FETCH_VIDEOS_SQL = """
SELECT v.video_id, v.group_key, v.is_short, v.published_at,
       v.viral_velocity_ratio,
       g.debut_date,
       s.views    AS view_count,
       s.likes    AS like_count,
       s.comments AS comment_count
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
"""


_UPSERT_VIDEO_SQL = """
INSERT INTO debut_window_video_organicity
  (video_id, group_key, is_short, published_at,
   days_relative_to_debut, window_bucket,
   view_count, like_count, comment_count,
   engagement_rate, like_comment_ratio, velocity_ratio,
   organic_score, verdict, causes, signal_breakdown, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  causes=excluded.causes,
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
    """Score every video in each group with a debut_date, return upsert
    statements. V3.1 (2026-05-25): all videos scored — Pre/Post buckets
    catch ±60d outside videos. Idempotent on video_id."""
    rows = client.execute(_FETCH_VIDEOS_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list[Any]]] = []

    for r in rows:
        days_rel = _days_between(r["debut_date"], r["published_at"])
        bucket = bucket_for(days_rel)
        if bucket is None:
            continue  # defensive — Pre/Post catch all post-V3.1, should not trip

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

        causes_json = json.dumps(breakdown.get("causes", []))
        statements.append((_UPSERT_VIDEO_SQL, [
            r["video_id"], r["group_key"], video["is_short"],
            r["published_at"], days_rel, bucket,
            view_count, like_count, comment_count,
            engagement_rate, like_comment_ratio, video["viral_velocity_ratio"],
            score, verdict, causes_json, json.dumps(breakdown), now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )


_FETCH_VIDEO_ORG_SQL = """
SELECT group_key, window_bucket, is_short,
       view_count, like_count, comment_count,
       organic_score, verdict
FROM debut_window_video_organicity
"""


# build_summary is a full recompute from the per-video table, so the summary
# table is cleared before the rebuild upserts. Without this, a (group, bucket)
# row that emptied out — e.g. when a group's debut_date shifts (migration 0074
# moved wegosix to 2026-08-31, pushing every existing video into the Pre
# bucket) — would survive with a frozen score because the upserts only touch
# buckets that still have videos. The leading DELETE keeps the summary an exact
# mirror of the current per-video classification.
_CLEAR_SUMMARY_SQL = "DELETE FROM debut_window_organicity_summary"


_UPSERT_SUMMARY_SQL = """
INSERT INTO debut_window_organicity_summary
  (group_key, window_bucket, video_count, long_form_count, short_form_count,
   organic_score_mean, organic_score_mean_long, organic_score_mean_short,
   organic_score_mean_simple,
   organic_strong_ratio, organic_ratio, borderline_ratio,
   suspect_ratio, likely_paid_ratio,
   total_views, total_engagement, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key, window_bucket) DO UPDATE SET
  video_count=excluded.video_count,
  long_form_count=excluded.long_form_count,
  short_form_count=excluded.short_form_count,
  organic_score_mean=excluded.organic_score_mean,
  organic_score_mean_long=excluded.organic_score_mean_long,
  organic_score_mean_short=excluded.organic_score_mean_short,
  organic_score_mean_simple=excluded.organic_score_mean_simple,
  organic_strong_ratio=excluded.organic_strong_ratio,
  organic_ratio=excluded.organic_ratio,
  borderline_ratio=excluded.borderline_ratio,
  suspect_ratio=excluded.suspect_ratio,
  likely_paid_ratio=excluded.likely_paid_ratio,
  total_views=excluded.total_views,
  total_engagement=excluded.total_engagement,
  computed_at=excluded.computed_at
"""


def _weighted_or_simple_mean(rows: list[dict]) -> tuple[float | None, float | None]:
    """Return (view_weighted_mean, simple_mean) over scored rows.
    None when rows is empty."""
    if not rows:
        return None, None
    weight_sum = sum(r.get("view_count") or 0 for r in rows)
    if weight_sum > 0:
        view_weighted = sum(
            (r["organic_score"] or 0) * (r.get("view_count") or 0)
            for r in rows
        ) / weight_sum
    else:
        view_weighted = sum(r["organic_score"] or 0 for r in rows) / len(rows)
    simple = sum(r["organic_score"] or 0 for r in rows) / len(rows)
    return view_weighted, simple


def build_summary(client: _Executor) -> CollectionResult:
    """Aggregate the per-video organicity table into per-(group, bucket)
    summary rows. ``insufficient_data`` videos still count toward
    video_count and total_views/engagement, but are excluded from
    score_mean and ratio denominators so noise doesn't skew judgment."""
    rows = client.execute(_FETCH_VIDEO_ORG_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        grouped[(r["group_key"], r["window_bucket"])].append(r)

    # Clear first so emptied (group, bucket) rows don't persist (see
    # _CLEAR_SUMMARY_SQL). Sequenced ahead of the rebuild upserts in the same
    # batch; a partial-write failure surfaces as a non-zero orchestrator exit
    # and the next cron rebuilds from scratch.
    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SUMMARY_SQL, [])]
    for (group_key, bucket), bucket_rows in grouped.items():
        scored = [r for r in bucket_rows if r.get("verdict") != "insufficient_data"]
        scored_long = [r for r in scored if not (r.get("is_short") or 0)]
        scored_short = [r for r in scored if (r.get("is_short") or 0)]
        long_count = sum(1 for r in bucket_rows if not (r.get("is_short") or 0))
        short_count = sum(1 for r in bucket_rows if (r.get("is_short") or 0))

        score_mean, score_mean_simple = _weighted_or_simple_mean(scored)
        score_mean_long, _ = _weighted_or_simple_mean(scored_long)
        score_mean_short, _ = _weighted_or_simple_mean(scored_short)

        if scored:
            n = len(scored)
            strong_ratio = sum(1 for r in scored if r["verdict"] == "organic_strong") / n
            organic_ratio = sum(1 for r in scored if r["verdict"] == "organic") / n
            borderline_ratio = sum(1 for r in scored if r["verdict"] == "borderline") / n
            suspect_ratio = sum(1 for r in scored if r["verdict"] == "suspect") / n
            likely_ratio = sum(1 for r in scored if r["verdict"] == "likely_paid") / n
        else:
            strong_ratio = None
            organic_ratio = None
            borderline_ratio = None
            suspect_ratio = None
            likely_ratio = None

        total_views = sum((r.get("view_count") or 0) for r in bucket_rows)
        total_engagement = sum(
            (r.get("like_count") or 0) + (r.get("comment_count") or 0)
            for r in bucket_rows
        )

        statements.append((_UPSERT_SUMMARY_SQL, [
            group_key, bucket, len(bucket_rows), long_count, short_count,
            score_mean, score_mean_long, score_mean_short, score_mean_simple,
            strong_ratio, organic_ratio, borderline_ratio,
            suspect_ratio, likely_ratio,
            total_views, total_engagement, now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
