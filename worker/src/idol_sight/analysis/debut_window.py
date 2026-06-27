"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos. debut_date 있는 그룹의 모든 영상을 채점하며, Pre + 산술 D+N 버킷이
전 기간을 커버하므로 [전체 기간] view 에서 모든 영상이 ER/Score/판정 렌더
가능. (이력: V3.1 2026-05-25 전 영상 채점 도입 → V2.49 2026-06-11 Post
catch-all 폐기, d>=10 은 20일 폭 산술 생성 D+20, D+40, … 무한.)

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
    "ORGANICITY_PRIOR",
    "ORGANICITY_SHRINKAGE_K",
    "bucket_for",
    "compute_organic_score",
    "build_video_organicity",
    "build_summary",
]

# (label, days_lo_inclusive, days_hi_inclusive). V2.34 (2026-05-27):
# 균등 20일 폭 통일 (이전 이력). V2.49 (2026-06-11) 롤링 윈도우:
# 음수 측(데뷔 전) + D-Day 만 고정 목록.
# d >= 10 (데뷔 후) 는 bucket_for 가 산술 생성 — k = (d-10)//20 + 1 →
# f"D+{20k}" (20일 폭 무한 시리즈: D+20, D+40, …, D+80, D+100, …).
# 'Post' catch-all 은 폐기 (migration 0085 가 기존 행 재배치). 'Pre' 는
# 유지 — 표시 창이 과거로는 밀리지 않으므로 음수 무한 시리즈는 불필요.
#
# 표시 창(연속 7버킷)은 frontend functions/lib/debutWindowBuckets.ts 가
# anchor(MiiWAN) 데뷔 경과일로 계산. 경계 동일성은 frontend
# tests/lib/debutWindow.test.ts 의 cross-language fixture 가 핀.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("Pre",   -999999, -71),
    ("D-60",     -70,  -51),
    ("D-40",     -50,  -31),
    ("D-20",     -30,  -11),
    ("D-Day",    -10,    9),
]

# Engagement-rate boundaries. Long-form: V2 calibrated 2026-05-13 (long p10=1.57%
# p90=6.69%). Below floor = 0pt, above ceiling = 100pt, linear interpolation.
LONG_ER_FLOOR, LONG_ER_CEIL = 0.010, 0.060
# Shorts: V2.37 recalibrated 2026-06-05 from the live 6,258-Short remote D1
# distribution (ER p10=2.65% p50=4.81% p90=10.74%). The V2 shorts floor (1.5%)
# was *below* the real p10 and the ceiling (8.0%) sat at ~p80, so the curve was
# miscalibrated. V2.37 treats ER as a *strength* signal, not a paid signal: the
# floor is set deliberately LOW (0.5%) so a merely-weak Short isn't auto-zeroed
# the way 꿍싯꿍싯 (ER 0.91%) was — only genuinely dead engagement (the MV-teaser
# pattern at ER ~0.1%) bottoms out. Authenticity is judged by balance, below.
SHORT_ER_FLOOR, SHORT_ER_CEIL = 0.005, 0.090

# Like:comment ratio normal zone. Long-form: V2 (K-pop long ratios distribute
# low). Shorts: V2.37 recalibrated to the live distribution (like:comment
# p10=15.1 p50=41.0 p90=78.2) — the V2 shorts ceiling (150) was nearly double
# the real p90, so like-farms above ~80 went unpenalized. Outside the zone
# penalizes asymmetric activity (comment-farm below, like-farm above); for
# Shorts this balance signal is the *primary* organic-vs-manipulated axis.
BALANCE_NORMAL_LONG_LO, BALANCE_NORMAL_LONG_HI = 10.0, 50.0
BALANCE_NORMAL_SHORT_LO, BALANCE_NORMAL_SHORT_HI = 15.0, 78.0
BALANCE_LONG_LOW_PENALTY_PER_UNIT = 8.0   # long ratio<10 → comment-farm slope
BALANCE_LONG_HIGH_PENALTY_PER_UNIT = 0.5  # long ratio>50 → like-farm slope
BALANCE_SHORT_LOW_PENALTY_PER_UNIT = 5.0  # short ratio<15 → comment-farm slope
BALANCE_SHORT_HIGH_PENALTY_PER_UNIT = 0.4 # short ratio>78 → like-farm slope

# V2.39 (2026-06-07) Shorts low-comment balance guard. like_comment_ratio
# (likes/max(comments,1)) is dominated by ±1-comment noise when comments are
# few, so a healthy small Short with 1-2 comments explodes past the p90 ceiling
# (78) and trips a spurious like-farm penalty — the "댓글 1개 절벽" (0 comments
# scored 93, 1 comment scored 39). Below MIN comments the ratio is not a
# trustworthy authenticity signal, so balance is neutralized (b=100) — UNLESS
# the Short is high-view: high views + few comments + the resulting near-dead ER
# is the genuine cold-traffic/paid signature, where farm detection must stay
# live. See docs/superpowers/specs/2026-06-07-organicity-shorts-low-comment-guard-design.md.
BALANCE_MIN_COMMENTS_SHORT = 10
BALANCE_LOW_VIEW_CEIL_SHORT = 50_000

# Velocity-engagement coherence cross-check. NULL velocity is treated as a
# missing signal (weight redistributed) — V2 calibration discovered ~91%
# of videos have NULL viral_velocity_ratio so the V1 fixed-50 mid-point was
# masking real signal weight.
# below = neutral (50pt). Intentionally distinct from platform_reactivity's
# VIRAL_THRESHOLD (2.0): that one selects videos to sample for reactivity; this
# gates the organicity velocity-coherence signal. Same column, different purpose.
VIRAL_VELOCITY_THRESHOLD = 1.5
VIRAL_ER_REAL = 0.03                     # ER above this with viral velocity = real
VIRAL_ER_WEAK = 0.015                    # ER above this = weak suspicion

# When velocity is present, weights are 0.5/0.3/0.2. When velocity is NULL,
# the 0.2 share redistributes proportionally between engagement and balance
# (0.5/0.8 = 0.625, 0.3/0.8 = 0.375).
_WEIGHTS_RAW = {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}
_WEIGHTS_NO_VELOCITY_RAW = {"engagement": 0.625, "balance": 0.375}
WEIGHTS: Mapping[str, float] = MappingProxyType(_WEIGHTS_RAW)
WEIGHTS_NO_VELOCITY: Mapping[str, float] = MappingProxyType(_WEIGHTS_NO_VELOCITY_RAW)

# Shorts (V2.37): velocity is dropped entirely — viral_velocity_ratio is
# views-over-baseline, which explodes off a near-zero pre-debut channel baseline
# (꿍싯꿍싯 showed 18.5 at only 38K views) and produced the paid_burst false
# positive. Shorts are judged purely on the two scale-invariant ratio signals.
# Balance is weighted ABOVE engagement (0.6 vs 0.4) so that a Short with weak
# engagement but a *normal* like:comment balance (cold/passive reach, not
# manipulation) lands in borderline rather than being condemned as paid — only
# an abnormal balance (farm) or genuinely dead engagement drags it to paid.
_SHORT_WEIGHTS_RAW = {"engagement": 0.4, "balance": 0.6}
SHORT_WEIGHTS: Mapping[str, float] = MappingProxyType(_SHORT_WEIGHTS_RAW)


# Thin-sample shrinkage (V2.50, 2026-06-17). A bucket's headline organicity is
# the simple mean of its scored videos — volume-independent BY DESIGN
# (organicity answers "is the engagement authentic?", not "is the group
# growing / posting enough?"; growth lives in the separate Growth Trajectory
# layer, V2.43). But a bucket with only 1-2 scored videos yields a
# confident-looking mean from almost no evidence, so a group that posts
# few-but-organic videos reads as "thriving" when it is merely "not obviously
# paid" — the exact "오가닉이라는 이유로 높은 점수" failure an operator flagged.
# We shrink the simple mean toward a neutral prior (the borderline midpoint)
# with pseudocount k: a thin bucket is pulled toward neutral, and the pull
# vanishes as real video volume accumulates (n≫k → shrunk ≈ raw). The raw means
# (organic_score_mean / _simple) stay stored untouched — the shrunk value is the
# headline, the raw values remain available as the catalog/reach lenses.
# scored_video_count (the true sample size behind the mean, excluding
# insufficient_data) is stored alongside so the frontend can flag thin buckets.
ORGANICITY_PRIOR = 55.0          # borderline midpoint (neutral posture)
ORGANICITY_SHRINKAGE_K = 3.0     # pseudocount: n=1 → ¾ pulled to prior, n=9 → ¼


def _shrink_toward_prior(simple_mean: float | None, scored_n: int) -> float | None:
    """Bayesian shrinkage of a bucket's simple mean toward the neutral prior.

    Returns None when there is no scored evidence (mirrors the raw means, which
    are also None for an all-insufficient_data bucket). shrunk =
    (n·mean + k·prior) / (n + k): n=1 mean=90 → 63.75 (borderline, not
    organic_strong); n=10 mean=90 → 81.9 (essentially unchanged).
    """
    if simple_mean is None or scored_n <= 0:
        return None
    return (
        scored_n * simple_mean + ORGANICITY_SHRINKAGE_K * ORGANICITY_PRIOR
    ) / (scored_n + ORGANICITY_SHRINKAGE_K)


# V2.42: groups without an announced debut_date can't be windowed (no anchor
# for days_relative_to_debut), but the organic score itself is anchor-
# independent — compute_organic_score reads only view/like/comment/velocity.
# Their videos are scored into this synthetic bucket so the KPI card can show a
# pre-debut posture. days_relative is stored as 0 (placeholder, never rendered:
# the table's "전체 기간" view shows the published date, not the day offset).
UNDATED_BUCKET = "Undated"


def bucket_for(days_relative: int) -> str:
    """Map a signed day offset to its bucket label.

    ``days_relative`` is days from debut: negative = before, positive = after.
    음수/D-Day 는 WINDOW_BUCKETS 고정 목록, d >= 10 은 20일 폭 산술 생성
    (무한 시리즈). V2.49 부터 총함수 — None 을 반환하지 않는다.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    k = (days_relative - 10) // 20 + 1
    return f"D+{20 * k}"


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
    long-form 10-50, shorts 15-78. Outside zone penalizes farms."""
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

    safe_views = max(view_count, 1)
    safe_comments = max(comment_count, 1)
    # UNWEIGHTED engagement rate (likes + comments, no comment weighting) —
    # INTENTIONALLY distinct from health_score.engagement_rate which weights
    # comments ×5 (COMMENT_WEIGHT=5). Organicity calibration (SHORT_ER_FLOOR/CEIL
    # etc.) was tuned against this unweighted definition; do NOT "unify" them.
    engagement_rate = engagement_total / safe_views
    like_comment_ratio = like_count / safe_comments

    e_score = _compute_engagement_score(engagement_rate, is_short)
    b_score = _compute_balance_score(like_comment_ratio, is_short)
    balance_basis = "ratio"

    # V2.37 0-comment Shorts guard: a Short with 0 comments is normal (tap-like,
    # no comment), but like_comment_ratio degenerates to the absolute like count
    # (likes/1) — not scale-invariant — so a healthy, well-liked small Short
    # reads as a like-farm under the balance-dominant Short weighting. We can't
    # judge authenticity without comments, so treat balance as neutral (no farm)
    # rather than emit a false paid flag. Long-form keeps its intentional
    # like-only-as-farm behavior (comments are expected there).
    #
    # V2.39 low-comment guard (see constants above): generalize the 0-comment
    # case — below BALANCE_MIN_COMMENTS_SHORT the ratio is too noisy to trust, so
    # neutralize balance. The high-view exception keeps farm detection live where
    # few comments is a cold-traffic signal, not just small-sample.
    if is_short and comment_count == 0:
        b_score = 100
        balance_basis = "zero_comment"
    elif (
        is_short
        and comment_count < BALANCE_MIN_COMMENTS_SHORT
        and view_count < BALANCE_LOW_VIEW_CEIL_SHORT
    ):
        b_score = 100
        balance_basis = "insufficient_comments"

    if is_short:
        # V2.37: Shorts judged on scale-invariant ratios only — velocity is
        # dropped (see SHORT_WEIGHTS). No absolute-view gate; a small Short with
        # healthy ratios is scored, a high-view Short with dead engagement is
        # flagged. Balance-weighted so weak-but-balanced reach ≠ paid.
        v_score = None
        composite = round(
            SHORT_WEIGHTS["engagement"] * e_score
            + SHORT_WEIGHTS["balance"]   * b_score
        )
        weights_used = dict(SHORT_WEIGHTS)
    else:
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
        "balance_basis": balance_basis,
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
WHERE v.published_at IS NOT NULL
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
    statements. V3.1 (2026-05-25): all videos scored. Pre + 산술 D+N(20일 폭
    무한)이 전 기간을 커버한다. Post catch-all은 V2.49에서 폐기(d>=10은
    산술 D+20k 무한 생성). Idempotent on video_id."""
    rows = client.execute(_FETCH_VIDEOS_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list[Any]]] = []

    for r in rows:
        debut_date = r.get("debut_date")
        if debut_date:
            days_rel = _days_between(debut_date, r["published_at"])
            bucket = bucket_for(days_rel)
        else:
            # V2.42: no announced debut → score anyway, park in Undated.
            days_rel = 0
            bucket = UNDATED_BUCKET

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
   total_views, total_engagement,
   scored_video_count, organic_score_mean_shrunk, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  scored_video_count=excluded.scored_video_count,
  organic_score_mean_shrunk=excluded.organic_score_mean_shrunk,
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

        # Thin-sample headline: shrink the simple mean toward the neutral prior
        # so a 1-2 video bucket can't show a confident organic_strong. scored_n
        # is the true sample size behind the mean (excludes insufficient_data).
        scored_n = len(scored)
        score_mean_shrunk = _shrink_toward_prior(score_mean_simple, scored_n)

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
            total_views, total_engagement,
            scored_n, score_mean_shrunk, now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
