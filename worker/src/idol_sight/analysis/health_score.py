"""Health Score (spec §7.1) — V2.5 4-factor model.

Pure function — input dict, output HealthScore. The computation is
intentionally small and centralised here so the frontend can request
the same weights via /api/health/spec.

REF values used to be hard-coded (subs=1M, views=200M, quality=10M,
community=200K, news=500). That made PLAVE saturate at 1.0 across all
five dimensions while every other group landed at 0.05–0.3 — the BI
lost discrimination power for the bottom seven groups. We now compute
REF dynamically from the cohort's p75 (the 75th-percentile value across
all active groups in the same snapshot), so the scale stretches
naturally as the market grows. ``compute_dynamic_refs`` returns the
REFs and ``compute_health_score`` accepts a ``refs`` dict to use
instead of the fallback constants.

Quality is now an engagement-rate signal: (likes + 5·comments) / views
across recent videos. The old "top10 average views" was really a
viewership measure (correlates with channel size), not quality.

V2.5 — 4-Factor model (Anthropologist's recommendation):

The Health Score now decomposes into four bundles that match how an
idol's traction actually accrues, not the raw signals it leaves behind:

  Reach           구독자, 조회수, 뉴스 — raw audience size signals.
  RitualVictory   chart entries, 음방 1위, hanteo / external collabs —
                  ritual win events that the fandom organizes around.
  Mobilization    초동 sales, 콘서트 매진, 멤버십 가입자, recent video
                  cadence — fan dollars and fan time being put on the
                  table for the group.
  Intimacy        engagement_rate, community posts, livestream/collab
                  signals — depth of fan relationship.

The four factors carry **model-specific weights** keyed to a group's
entity type (corporate / segmentary / confederation):

  corporate     PLAVE-style — Reach 25, Ritual 30, Mobilization 30,
                Intimacy 15 (ritual + mobilization = album-driven)
  segmentary    ISEDOL-style — Reach 20, Ritual 15, Mobilization 25,
                Intimacy 40 (intimacy weighted up — Waktaverse depends
                on personal channels and live)
  confederation STELLIVE-style — Reach 15, Ritual 10, Mobilization 20,
                Intimacy 55 (intimacy dominant — V-tuber model)

The function still emits the old 6-component breakdown
(subscribers/views/quality/community/news/risk) for backward
compatibility with existing callers and the /api/health/spec contract,
but it adds a parallel ``factors`` dict that the frontend can render
as the V2.5 view. Risk continues to multiply the base score (a
controversy spike compresses every factor, not just one).
"""

from __future__ import annotations

import math
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

# When computing dynamic refs we use p75 (75th percentile) of the cohort.
# 1.0 then means "this group sits at the top decile of the market", which
# is the right semantic for an idol BI: top tier = saturated, mid tier =
# half-filled, debut tier = small but visible.
# V2.14: 0.90 → 0.75. With 7 active groups + PLAVE 5-10× the rest on
# every axis, p90 effectively = PLAVE → SKINZ/OWIS/MY:RAKL all
# normalize to <0.1 and pile into D-tier indistinguishably. p75 means
# "1.0 = top quartile" and stretches the bottom range from [0–0.1] to
# [0–0.3] giving the small groups room to differentiate without
# affecting PLAVE/ISEDOL (still saturate at 1.0).
DYNAMIC_REF_PERCENTILE = 0.75
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

# V2.5 4-factor weights per group_model. Each row sums to 100 so the
# percentage interpretation is direct ("PLAVE: 30% of its Health Score
# comes from RitualVictory"). corporate is the safe default for any
# group missing a model classification.
FACTOR_WEIGHTS: dict[str, dict[str, int]] = {
    "corporate": {
        "reach":         25,
        "ritual":        30,
        "mobilization":  30,
        "intimacy":      15,
    },
    "segmentary": {
        "reach":         20,
        "ritual":        15,
        "mobilization":  25,
        "intimacy":      40,
    },
    "confederation": {
        "reach":         15,
        "ritual":        10,
        "mobilization":  20,
        "intimacy":      55,
    },
}
DEFAULT_GROUP_MODEL = "corporate"
# Bonus stays an additive overlay, not part of the 4-factor split — it's
# a recency reward that shouldn't depend on the group model.
FACTOR_BONUS_MAX = 10
FACTOR_DENOM = 100 + FACTOR_BONUS_MAX  # = 110

# Sparse-collector defense: when a metric column has zero signal across
# the entire cohort — e.g. a collector is temporarily offline, or the
# metric is a not-yet-live stub (music_show_wins) — it gets dropped from
# the Health Score formula entirely. Otherwise every group eats a 0/REF
# normalization on that axis and intimacy / community factors collapse —
# the heaviest-weighted bands hit segmentary (40) and confederation (55)
# the worst. Dropping the dead metric and renormalizing the remaining
# weights inside the same factor keeps the score interpretable.
#
# V2.16: ritual factor opts OUT of redistribution (see _wmean
# ``redistribute`` flag + _factor_inputs). For ritual specifically we
# want hanteo absence to read as "this group has no album cycle this
# window" — i.e. real loss of the ritual signal — not "redistribute the
# 0.5 weight to news so a single naver hit count carries the whole
# factor". Reach / Mobilization / Intimacy keep redistribute=True.
#
# P1: music_show_wins is the one ritual signal exempt from this. Its
# collector is a stub (dead across the whole cohort), so leaving its
# 0.20 weight in the denominator capped ritual at 0.80 for every
# group. When music_show is cohort-dead the ritual block drops its
# part so the weight redistributes; when it's cohort-alive but a
# single group has no wins, the part stays as a genuine penalty.
_ALL_METRICS = frozenset({
    "subscribers", "views", "news", "quality", "community", "hanteo",
    "music_show_wins", "chart_peak", "chart_depth",
})


@dataclass
class HealthScore:
    total: float | None
    raw_total: float | None
    grade: str
    label: str
    breakdown: dict[str, float] = field(default_factory=dict)
    bonus: dict[str, float] = field(default_factory=dict)
    quality_method: str = "n/a"
    # V2.5 additions — non-breaking. Older callers ignore these.
    factors: dict[str, float] = field(default_factory=dict)
    group_model: str = DEFAULT_GROUP_MODEL


def _is_pre_debut(debut_date: str | None) -> bool:
    if not debut_date:
        return True
    try:
        d = date.fromisoformat(debut_date)
    except ValueError:
        return True
    return d > date.today()


# V2.16: cold-start floor removed. The earlier 3.5-pt floor for
# debut < 90d groups was a participation lift — it inflated B:DAWN
# (raw 1.9 → 3.5) and any other neonate against the absolute scale.
# The user wants absolute scoring: a group on day 1 with no traction
# reads near-zero, which is correct. The floor masked this.


def _normalize(value: float | None, ref: float) -> float:
    """Clamp value/ref to [0, 1]. None coerces to 0 — the live-metric
    layer (cohort + per-group) already excludes truly-dead metrics from
    weighted means, so a stray None at the normalizer just yields 0
    rather than raising.
    """
    if value is None or ref <= 0:
        return 0.0
    return min(max(value / ref, 0.0), 1.0)


def _normalize_log(value: float | None, ref: float) -> float:
    """log1p-based [0, 1] normalize.

    Used for news only (V2.17): naver_total_news is highly volatile —
    영문 그룹명("SKINZ")은 한국 naver 뉴스에 거의 안 잡혀 raw 2회,
    한글 표기 그룹("미라클" 등)은 같은 인기에서도 raw 5-10회로 잡힌다.
    Linear normalize에서는 그 2.5× 차이가 reach/ritual 점수를 결정적으로
    가르지만 시장 인기와 무관한 group-name spelling 효과. log scale로
    변환하면 작은 raw 차이가 정규화 후 더 작아져 (2 vs 5 linear 0.25 vs
    0.625 → log 0.50 vs 0.81) 영향력이 절반 가까이 줄어든다. 한계도 같
    이 줄어들어 raw 5000+ 같은 outlier도 saturate.

    Subscribers / views는 채널-단위 누적이라 분포가 비교적 균질해 linear
    유지. quality(engagement rate)는 이미 ratio 기반이라 log 불필요.
    """
    if value is None or value <= 0 or ref <= 0:
        return 0.0
    return min(math.log1p(value) / math.log1p(ref), 1.0)


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


def _per_group_live(agg: dict[str, Any]) -> set[str]:
    """Return the set of metric keys this *individual* group has signal
    for. Combines with cohort-level live (see ``compute_live_metrics``)
    to also defend against NULL columns in a single group's row — e.g.
    PLAVE's ``yt_total_views = NULL`` left over from V2.11 migration
    cleanup. Without this layer the group eats a 0/REF normalization
    on the dead column even though the cohort is otherwise healthy.

    The ``> 0`` threshold treats genuine NULL / 0 as dead. A group with
    a tiny but non-zero value (e.g. 50 subscribers) is still alive — its
    score just normalizes low, which is the correct outcome.
    """
    live: set[str] = set()
    if float(agg.get("yt_subscribers", 0) or 0) > 0:
        live.add("subscribers")
    if float(agg.get("yt_total_views", 0) or 0) > 0:
        live.add("views")
    if float(agg.get("naver_total_news", 0) or 0) > 0:
        live.add("news")
    if _engagement_rate(agg) > 0:
        live.add("quality")
    comm_total = (float(agg.get("dc_total_posts", 0) or 0)
                  + float(agg.get("theqoo_posts", 0) or 0)
                  + float(agg.get("instiz_posts", 0) or 0))
    if comm_total > 0:
        live.add("community")
    if float(agg.get("hanteo_sales", 0) or 0) > 0:
        live.add("hanteo")
    if float(agg.get("music_show_wins", 0) or 0) > 0:
        live.add("music_show_wins")
    # chart_peak: 1~100 (lower = better). 0 또는 NULL = 미진입 (dead).
    peak = agg.get("melon_top100_peak")
    if peak is not None and 1 <= int(peak) <= 100:
        live.add("chart_peak")
    # chart_depth: TOP 100 진입곡 수. 0 또는 NULL = 미진입 (dead).
    depth = agg.get("melon_top100_depth")
    if depth is not None and int(depth) > 0:
        live.add("chart_depth")
    return live


def compute_live_metrics(cohort: list[dict[str, Any]]) -> set[str]:
    """Return the set of metric keys with at least one non-zero signal
    across the cohort. Metrics absent from the set are dropped from the
    factor formulas and their weight redistributes to remaining live
    signals in the same factor (see _wmean / _factor_inputs).

    Truth table:
      "subscribers" - any g.yt_subscribers > 0
      "views"       - any g.yt_total_views > 0
      "news"        - any g.naver_total_news > 0
      "quality"     - any _engagement_rate(g) > 0
      "community"   - any (dc + theqoo + instiz) > 0
      "hanteo"      - any g.hanteo_sales > 0
    """
    live: set[str] = set()
    if any(float(g.get("yt_subscribers", 0) or 0) > 0 for g in cohort):
        live.add("subscribers")
    if any(float(g.get("yt_total_views", 0) or 0) > 0 for g in cohort):
        live.add("views")
    if any(float(g.get("naver_total_news", 0) or 0) > 0 for g in cohort):
        live.add("news")
    if any(_engagement_rate(g) > 0 for g in cohort):
        live.add("quality")
    if any(
        (float(g.get("dc_total_posts", 0) or 0)
         + float(g.get("theqoo_posts", 0) or 0)
         + float(g.get("instiz_posts", 0) or 0)) > 0
        for g in cohort
    ):
        live.add("community")
    if any(float(g.get("hanteo_sales", 0) or 0) > 0 for g in cohort):
        live.add("hanteo")
    if any(float(g.get("music_show_wins", 0) or 0) > 0 for g in cohort):
        live.add("music_show_wins")
    if any(
        (g.get("melon_top100_peak") is not None
         and 1 <= int(g.get("melon_top100_peak") or 0) <= 100)
        for g in cohort
    ):
        live.add("chart_peak")
    if any(int(g.get("melon_top100_depth") or 0) > 0 for g in cohort):
        live.add("chart_depth")
    return live


def _wmean(
    parts: list[tuple[float, float, bool]],
    *,
    redistribute: bool = True,
) -> float:
    """Weighted mean over parts marked alive=True.

    Each part is (value, weight, alive).

    ``redistribute=True`` (default): dead parts skipped in BOTH
    numerator and denominator so surviving weights renormalize. Useful
    for sparse-collector defense — if a cohort-wide signal is dead, the
    remaining signals carry full weight.

    ``redistribute=False``: dead parts contribute 0 to the numerator
    but their weight stays in the denominator. The factor genuinely
    drops by the missing weight share. Used by ritual (V2.16) where
    hanteo absence must NOT redistribute to news — that's the bug we're
    fixing in the corporate-without-album-cycle case.

    Returns 0 when total weight is zero (degenerate input).
    """
    if redistribute:
        live = [(v, w) for v, w, alive in parts if alive]
        if not live:
            return 0.0
        total_w = sum(w for _, w in live)
        if total_w <= 0:
            return 0.0
        return sum(v * w for v, w in live) / total_w

    total_w = sum(w for _, w, _ in parts)
    if total_w <= 0:
        return 0.0
    return sum((v if alive else 0.0) * w for v, w, alive in parts) / total_w


def compute_dynamic_refs(
    cohort: list[dict[str, Any]],
) -> dict[str, float]:
    """Derive per-dimension REF values from cohort p75.

    ``cohort`` is the list of agg dicts (one per active virtual-idol
    group, same snapshot) that's about to feed into
    ``compute_health_score``.

    We compute each REF as max(p75 of cohort, MIN_REFS[dim]) so:

    - top tier (≥p75)   → normalized to 1.0
    - mid tier          → ~0.5
    - debut tier        → small but non-saturated
    """
    refs: dict[str, float] = {}
    sub_vals = [float(g.get("yt_subscribers", 0) or 0) for g in cohort]
    view_vals = [float(g.get("yt_total_views", 0) or 0) for g in cohort]
    news_vals = [float(g.get("naver_total_news", 0) or 0) for g in cohort]
    qual_vals = [float(_engagement_rate(g)) for g in cohort]
    comm_vals = [
        float((g.get("dc_total_posts", 0) or 0)
              + (g.get("theqoo_posts", 0) or 0)
              + (g.get("instiz_posts", 0) or 0))
        for g in cohort
    ]

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
    # music_show_wins REF: 5 wins saturates a comeback cycle. Stays
    # fixed (not cohort-driven) because the signal is sparse and a
    # percentile over mostly-zero would be useless.
    refs["music_show_wins"] = 5.0
    return refs


# Comment weight in the engagement-rate formula. Comments require strictly more
# effort than a like, so they're a stronger fandom signal. Single source for the
# (likes + COMMENT_WEIGHT·comments)/views formula — also used by
# weekly_diagnosis_signals.engagement_rate_from_agg (different input keys, same
# math), so keep the formula here and have both call engagement_rate().
COMMENT_WEIGHT = 5


def engagement_rate(likes: float, comments: float, views: float) -> float:
    """(likes + COMMENT_WEIGHT·comments) / views. 0.0 when views<=0 — a safer
    default than dividing by something tiny."""
    if views <= 0:
        return 0.0
    return (likes + COMMENT_WEIGHT * comments) / views


def _engagement_rate(agg: dict[str, Any]) -> float:
    """(likes + 5·comments) / views across the group's recent videos, from a
    cli.py-rekeyed dict (likes_total / comments_total / yt_total_views)."""
    return engagement_rate(
        int(agg.get("likes_total", 0) or 0),
        int(agg.get("comments_total", 0) or 0),
        int(agg.get("yt_total_views", 0) or 0),
    )


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


def _factor_inputs(
    agg: dict[str, Any], r: dict[str, float],
    live_metrics: set[str] | frozenset[str] | None = None,
    cohort_live: set[str] | frozenset[str] | None = None,
) -> dict[str, float]:
    """Compute the [0, 1] saturated value for each 4-factor component
    BEFORE multiplying by the group-model weight. Returns a dict keyed
    on factor name. Each factor blends 1-3 normalized signals.

    ``live_metrics`` lists the metric keys that have signal across the
    cohort. Dead metrics drop out of the weighted mean and the surviving
    weights renormalize. Default = treat every metric as alive (the
    legacy behavior, preserved for callers that don't pass cohort
    awareness — e.g. unit tests).
    """
    L = live_metrics if live_metrics is not None else _ALL_METRICS
    # Cohort-level liveness (before the per-group intersection). Lets the
    # ritual factor tell "music_show is dead across the WHOLE cohort"
    # (stub collector → redistribute its weight) apart from "this one
    # group has no wins while others do" (a genuine penalty). Defaults to
    # L for direct callers (unit tests) that pass no separate cohort set.
    CL = cohort_live if cohort_live is not None else L
    sub_n = _normalize(agg.get("yt_subscribers", 0), r["subscribers"])
    view_n = _normalize(agg.get("yt_total_views", 0), r["views"])
    # V2.17: news는 log1p scale. 영문/한글 표기 비대칭 + naver hit count
    # 변동성 압축. 다른 정규화는 linear 유지.
    news_n = _normalize_log(agg.get("naver_total_news", 0), r["news"])
    eng_n = _normalize(_engagement_rate(agg), r["quality"])
    # Defensive: each community column may be NULL when the collector
    # row is missing or the source is paused (V2.11 cleanup left NULL
    # rather than 0 for dead sources). ``or 0`` prevents TypeError on
    # ``int + None`` while preserving the live-metrics fold-out — a
    # cohort-dead community signal is removed at the live_metrics
    # layer above this function, not here.
    comm_total = ((agg.get("dc_total_posts") or 0)
                  + (agg.get("theqoo_posts") or 0)
                  + (agg.get("instiz_posts") or 0))
    comm_n = _normalize(comm_total, r["community"])

    # Hanteo-driven mobilization (initial-week sales) when we have it.
    # Defaults to 0 when not provided (most groups, most weeks).
    hanteo_sales = float(agg.get("hanteo_sales", 0) or 0)
    # 1.0 saturates around 1M album sales (PLAVE millennium-album scale).
    hanteo_n = min(hanteo_sales / 1_000_000.0, 1.0)

    # V2.16 music_show_wins — explicit ritual signal. 음방 1위 누적
    # 횟수 (M Countdown / Show Champion / The Show / Music Bank /
    # Inkigayo). Saturates at refs["music_show_wins"] (default 5).
    # Collector is a stub — column exists in agg_summary but no live
    # crawler yet. Until then every group reads NULL/0 and the cohort-
    # level live_metrics fold-out drops it. As soon as one group gets
    # a manual seed or the collector ships, the signal activates.
    music_show_wins = float(agg.get("music_show_wins", 0) or 0)
    music_show_n = _normalize(music_show_wins, r.get("music_show_wins", 5.0))

    # V2.18 chart_peak — 멜론 TOP 100 최고 순위 (lower=better, 1~100).
    # 0 / NULL / >100 = 미진입 → 0. 진입 시 (101 - peak) / 100 = chart_n.
    # 1위면 1.0, 100위면 0.01. V2.19에서 weight 0.20 → 0.10 (절반은
    # chart_depth로 양도). collector는 realtime + day union의 best rank.
    peak_raw = agg.get("melon_top100_peak")
    if peak_raw is None or int(peak_raw) < 1 or int(peak_raw) > 100:
        chart_peak_n = 0.0
    else:
        chart_peak_n = (101 - int(peak_raw)) / 100.0

    # V2.19 chart_depth — 멜론 TOP 100 진입곡 수 (realtime + day union,
    # song_id dedup). PLAVE처럼 일간 1곡 / 실시간 6곡 진입 그룹과 단곡
    # 진입 그룹 변별 시그널. ref=5 saturated. 0 / NULL = 미진입 → 0.
    depth_raw = agg.get("melon_top100_depth")
    depth_ref = float(r.get("chart_depth", 5.0)) or 5.0
    if depth_raw is None or int(depth_raw) <= 0:
        chart_depth_n = 0.0
    else:
        chart_depth_n = min(float(depth_raw) / depth_ref, 1.0)

    # V2.14: video cadence (last 90 days) promoted from bonus-only to a
    # weighted Mobilization signal. Without this, a group like SKINZ
    # with 593 videos but no recent hanteo album barely registers on
    # mobilization (only the +0.9-pt bonus reflected it). 30 videos
    # in 90d (~10/mo) saturates. Always alive — derived from worker's
    # own youtube_videos table, no external collector.
    v90_count = float(agg.get("v90_count", 0) or 0)
    cadence_n = min(v90_count / 30.0, 1.0)

    # V2 sentiment polarity. negative_ratio in [0, 1] — 0 = no negative
    # signal, 1 = all classified posts negative/controversy. We interpret
    # high negativity as compressing intimacy (fans aren't intimate, they
    # are upset).
    neg_ratio = float(agg.get("negative_ratio", 0) or 0)
    intimacy_compression = max(0.0, 1.0 - neg_ratio)

    # V2.46: 라이브 CCV 충성도를 Intimacy 3번째 신호로. 데이터 있는 그룹만
    # (loyalty_score not None) 3신호로 확장하고, 없으면 기존 2신호 경로를
    # 그대로 타 점수 불변(재정규화 페널티 0 — 라이브 안 한 그룹 손해 없음).
    loyalty_raw = agg.get("loyalty_score")
    if loyalty_raw is not None:
        loyalty_n = max(0.0, min(float(loyalty_raw) / 100.0, 1.0))
        intimacy = _wmean([
            (eng_n,     0.40, "quality"   in L),
            (comm_n,    0.30, "community" in L),
            (loyalty_n, 0.30, True),
        ]) * intimacy_compression
    else:
        intimacy = _wmean([
            (eng_n,  0.55, "quality"   in L),
            (comm_n, 0.45, "community" in L),
        ]) * intimacy_compression

    return {
        # Reach — raw audience size: subscribers, views, news exposure.
        # V2.17: news weight 0.15 → 0.05. naver hit count는 group name
        # spelling effect로 SKINZ 같은 영문 brand 그룹이 한글 표기
        # 그룹 대비 systematically 낮게 잡힘 → reach 결정자가 되는
        # 부작용 차단. 0.10pt만큼 sub로 흡수.
        "reach": _wmean([
            (sub_n,  0.55, "subscribers" in L),
            (view_n, 0.40, "views"       in L),
            (news_n, 0.05, "news"        in L),
        ]),
        # RitualVictory — initial-album mobilization (Hanteo) + news
        # spike + music-show wins + 음원 차트 진입(peak) + 음원 차트
        # 깊이(depth). V2.16 redistribute=False 유지.
        # V2.19: chart_peak 0.20 → 0.10, chart_depth 0.10 신설 — 운영
        # 첫날 PLAVE 케이스(realtime 6곡 / day 1곡 진입)에서 best rank
        # 단독으로는 곡 깊이 변별이 안 됨을 발견. 차트 축 0.20을
        # peak/depth 반반 배정.
        # P1: hanteo/news/chart_peak/chart_depth stay redistribute=False
        # (absence = real ritual loss → penalty). music_show_wins is the
        # exception: its collector is a stub, so when it's dead across
        # the WHOLE cohort (not in CL) its 0.20 weight used to sit in the
        # denominator and cap ritual at 0.80 for everyone (corporate
        # groups chronically ~6% low on total). We drop the part in that
        # case so the weight redistributes (penalty 0). When music_show
        # is cohort-alive but THIS group has no wins, the part stays
        # (alive=False) and reads as a genuine penalty.
        "ritual": _wmean(
            [
                (hanteo_n,      0.50, "hanteo"      in L),
                (news_n,        0.10, "news"        in L),
                (chart_peak_n,  0.10, "chart_peak"  in L),
                (chart_depth_n, 0.10, "chart_depth" in L),
            ]
            + (
                [(music_show_n, 0.20, "music_show_wins" in L)]
                if "music_show_wins" in CL
                else []
            ),
            redistribute=False,
        ),
        # Mobilization — active output (cadence + views) + album-driven
        # initial-sales signal + subs. cadence carries 0.25 weight as
        # the always-alive internal signal; v30 stays in the additive
        # bonus on top.
        "mobilization": _wmean([
            (view_n,    0.40, "views"       in L),
            (cadence_n, 0.25, True),
            (hanteo_n,  0.25, "hanteo"      in L),
            (sub_n,     0.10, "subscribers" in L),
        ]),
        # Intimacy — engagement rate + community activity (+ V2.46 라이브
        # 충성도, 데이터 있을 때만), compressed by negative sentiment ratio.
        "intimacy": intimacy,
    }


def compute_health_score(
    group_key: str,
    agg: dict[str, Any],
    debut_date: str | None,
    *,
    refs: dict[str, float] | None = None,
    group_model: str | None = None,
    live_metrics: set[str] | frozenset[str] | None = None,
) -> HealthScore:
    if _is_pre_debut(debut_date):
        return HealthScore(
            total=None, raw_total=None,
            grade="PRE", label=GRADE_LABELS["PRE"],
            group_model=group_model or DEFAULT_GROUP_MODEL,
        )

    r = {**DEFAULT_REFS, **(refs or {})}
    cohort_L: set[str] | frozenset[str] = (
        live_metrics if live_metrics is not None else _ALL_METRICS
    )
    # Effective per-group live set = cohort-live ∩ this-group-live. The
    # intersection prevents a group with a NULL/0 column from eating a
    # 0/REF normalization on a metric the cohort otherwise has signal
    # in. Symmetric to the cohort-level fold-out: cohort-dead metrics
    # disappear for everyone, group-dead metrics disappear just for
    # that group, and surviving weights renormalize per factor.
    L = set(cohort_L) & _per_group_live(agg)
    model = group_model if group_model in FACTOR_WEIGHTS else DEFAULT_GROUP_MODEL
    weights = FACTOR_WEIGHTS[model]

    # ── Old 6-component breakdown (kept for backwards compatibility).
    #    Dead metrics surface as 0 contribution — accurate communication
    #    of "this signal isn't being collected" rather than "this group
    #    has none".
    sub_score = (
        _normalize(agg.get("yt_subscribers", 0), r["subscribers"])
        * WEIGHTS["subscribers"]
    ) if "subscribers" in L else 0.0
    view_score = (
        _normalize(agg.get("yt_total_views", 0), r["views"]) * WEIGHTS["views"]
    ) if "views" in L else 0.0
    eng_rate = _engagement_rate(agg)
    qual_score = (
        _quality_score_from_engagement(eng_rate, r["quality"])
        * WEIGHTS["quality"]
    ) if "quality" in L else 0.0
    # Same NULL defense as in _factor_inputs — see comment there.
    comm_total = ((agg.get("dc_total_posts") or 0)
                  + (agg.get("theqoo_posts") or 0)
                  + (agg.get("instiz_posts") or 0))
    comm_score = (
        _normalize(comm_total, r["community"]) * WEIGHTS["community"]
    ) if "community" in L else 0.0
    news_score = (
        _normalize(agg.get("naver_total_news", 0), r["news"]) * WEIGHTS["news"]
    ) if "news" in L else 0.0

    # ── V2.5 4-factor scores. Each saturated component gets multiplied
    #    by the model-specific weight, then the factor totals are
    #    multiplied by the controversy factor (so a scandal compresses
    #    *all four* dimensions, not just risk).
    risk_factor = _controversy_factor(agg.get("controversy_count", 0))
    fi = _factor_inputs(agg, r, live_metrics=L, cohort_live=cohort_L)
    factor_scores = {
        name: round(fi[name] * weights[name] * risk_factor, 2)
        for name in ("reach", "ritual", "mobilization", "intimacy")
    }
    factor_base = sum(factor_scores.values())

    bonus_total, bonus_dict = _recent_bonus(
        agg.get("v90_count", 0), agg.get("v30_count", 0),
    )

    raw_total = factor_base + bonus_total
    total = round(raw_total / FACTOR_DENOM * 10.0, 1)

    # V2.16: cold-start floor removed. Absolute scoring — a group
    # with no traction reads as such, regardless of tenure.

    grade = next(g for thr, g in GRADE_THRESHOLDS if total >= thr)

    # Risk score for the legacy breakdown — same factor, scaled by the
    # legacy WEIGHTS["risk"]. Doesn't enter the 4-factor total.
    risk_score = risk_factor * WEIGHTS["risk"]

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
        factors=factor_scores,
        group_model=model,
    )
